/**
 * Browser voice I/O: microphone level, speech-to-text, and text-to-speech
 * playback with an output level for the visualiser.
 *
 * Division of labour, deliberately:
 *   - Speech recognition is the browser's (free, no key, no round trip).
 *   - Reasoning is Agentforce's.
 *   - Speech synthesis is ElevenLabs', behind /api/tts so the key stays server-side.
 *
 * Half-duplex on purpose. The mic and the speaker are the same room, so if
 * recognition kept running while the agent talked it would transcribe the agent
 * and feed it straight back as the visitor's next turn. `Voice` stops listening
 * for the duration of playback and resumes after. The cost is no barge-in; the
 * alternative is an agent arguing with itself, which is worse.
 */

export type VoicePhase =
  /** Nothing running. */
  | 'idle'
  /** Mic open, waiting for or hearing the visitor. */
  | 'listening'
  /** Reply requested, audio not started yet. */
  | 'thinking'
  /** TTS playing. Mic is paused. */
  | 'speaking'

export type VoiceCallbacks = {
  /** Partial transcript, replaced on each update. Not a committed turn. */
  onInterim?: (text: string) => void
  /** A finished utterance. This is the text to send to the agent. */
  onFinal: (text: string) => void
  onPhase?: (phase: VoicePhase) => void
  /**
   * Non-fatal problems worth telling the visitor about — mic permission denied,
   * TTS unavailable. The conversation continues either way.
   */
  onNotice?: (message: string) => void
}

/* ---------------------------------------------- minimal Web Speech typings --- */
/* Not in every TypeScript dom lib, and prefixed on Safari, so declared here
   rather than depending on the ambient definitions. */

type SpeechRecognitionAlternative = { transcript: string; confidence: number }
type SpeechRecognitionResult = { isFinal: boolean; length: number; 0: SpeechRecognitionAlternative }
type SpeechRecognitionEventLike = {
  resultIndex: number
  results: { length: number } & Record<number, SpeechRecognitionResult>
}
type SpeechRecognitionErrorEventLike = { error: string }

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** True when this browser can transcribe speech. Firefox cannot, as of 2026. */
export function speechRecognitionSupported(): boolean {
  return recognitionCtor() !== null
}

/**
 * How long to wait after a final result before treating the turn as over.
 * Recognition emits a final segment at every natural pause, so sending on the
 * first one cuts people off mid-thought ("I need someone to come out" … "today").
 *
 * 600ms rather than 900: this sits in front of four to six seconds of planner
 * inference on every single turn, so it is the cheapest three tenths of a second
 * available anywhere in the chain. Do not go much lower — below about half a
 * second, ordinary mid-sentence pauses start being read as the end of a turn.
 */
const TURN_END_MS = 600

/** Analyser resolution. 512 bins is plenty for a single loudness number. */
const FFT_SIZE = 512

/**
 * Thrown when /api/tts declines to spend on this reply — the voice budget is
 * out, or the request was refused. Carries a message already written for the
 * visitor, so the caller shows it verbatim instead of appending a status code.
 */
export class VoiceQuietError extends Error {}

export class Voice {
  private cb: VoiceCallbacks
  private ctx: AudioContext | null = null

  private mic: MediaStream | null = null
  private micAnalyser: AnalyserNode | null = null
  private micBuf: Uint8Array<ArrayBuffer> | null = null

  private outAnalyser: AnalyserNode | null = null
  private outBuf: Uint8Array<ArrayBuffer> | null = null
  private source: AudioBufferSourceNode | null = null

  /**
   * The ambient hold pad. Synthesised, not a file: it has to loop for an unknown
   * stretch (a cold planner can take 30s) and fade cleanly whenever the reply
   * lands, which a fixed clip cannot do. `holdGain` is the fade handle; killing it
   * is how the tone stops.
   */
  private holdGain: GainNode | null = null
  private holdNodes: OscillatorNode[] = []

  private rec: SpeechRecognitionLike | null = null
  /** Whether recognition *should* be running; `onend` restarts it if so. */
  private wantListening = false
  private pending = ''
  private turnTimer: ReturnType<typeof setTimeout> | null = null

  private phase: VoicePhase = 'idle'
  private disposed = false
  /** Queue of replies to speak, so two fast agent messages don't overlap. */
  private queue: string[] = []
  private draining = false
  /** True from the moment a filler is requested until it is played or dropped. */
  private fillerPending = false
  /**
   * True between sending a turn and the reply arriving. Kept here because
   * `drain` decides what phase to return to when playback ends, and after a
   * filler that is still 'thinking', not 'listening'.
   */
  private awaitingReply = false

  constructor(cb: VoiceCallbacks) {
    this.cb = cb
  }

  get currentPhase(): VoicePhase {
    return this.phase
  }

  private setPhase(next: VoicePhase) {
    if (this.phase === next) return
    this.phase = next
    this.cb.onPhase?.(next)
  }

  /**
   * Must run inside the tap handler. iOS starts every AudioContext suspended and
   * only a user gesture may resume it; do this on a timer or after an await and
   * the visitor gets a silent call with no error.
   */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
      this.outAnalyser = this.ctx.createAnalyser()
      this.outAnalyser.fftSize = FFT_SIZE
      this.outAnalyser.smoothingTimeConstant = 0.75
      this.outAnalyser.connect(this.ctx.destination)
      this.outBuf = new Uint8Array(new ArrayBuffer(this.outAnalyser.frequencyBinCount))
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  /* ------------------------------------------------------- non-verbal cues --- */

  /**
   * A short two-note rising cue, played the instant the visitor taps — the
   * "connecting" beat a real call has and this demo did not. It buys a moment
   * before the greeting so tapping does not feel like talking to a recording that
   * was already running, and it is synthesised so it costs no ElevenLabs spend and
   * ships no asset. Routed through outAnalyser like everything else, so the
   * strands react to it.
   */
  connectCue(): void {
    const ctx = this.ctx
    if (!ctx || !this.outAnalyser) return
    const now = ctx.currentTime
    // Two soft sine blips, a rising fifth, ~110ms apart. Quiet on purpose: a cue,
    // not a chime.
    const notes = [
      { f: 523.25, t: 0 }, // C5
      { f: 783.99, t: 0.11 }, // G5
    ]
    for (const { f, t } of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      const at = now + t
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.12, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
      osc.connect(gain)
      gain.connect(this.outAnalyser)
      osc.start(at)
      osc.stop(at + 0.18)
    }
  }

  /**
   * Starts a soft ambient hold pad, fading in over ~400ms. Used for the tail of a
   * long wait — past the point where a second spoken line would sound like the
   * agent is nervous. Two detuned low sines, deliberately below speech so it reads
   * as "still here" rather than as an IVR hold. Idempotent: a second call while it
   * is already playing does nothing.
   */
  startHoldTone(): void {
    const ctx = this.ctx
    if (!ctx || !this.outAnalyser || this.holdGain) return
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.4)
    gain.connect(this.outAnalyser)
    // A gentle root plus a fifth a hair detuned, so it breathes instead of sitting
    // as a dead sustained tone.
    for (const f of [196, 294.3]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      osc.connect(gain)
      osc.start()
      this.holdNodes.push(osc)
    }
    this.holdGain = gain
  }

  /** Fades the hold pad out over ~250ms and tears the nodes down. Safe to call
   *  when nothing is playing. */
  stopHoldTone(): void {
    const ctx = this.ctx
    const gain = this.holdGain
    if (!ctx || !gain) return
    this.holdGain = null
    const nodes = this.holdNodes
    this.holdNodes = []
    const end = ctx.currentTime + 0.25
    try {
      gain.gain.cancelScheduledValues(ctx.currentTime)
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(0.0001, end)
    } catch {
      /* context may be closing */
    }
    for (const osc of nodes) {
      try {
        osc.stop(end)
      } catch {
        /* already stopped */
      }
    }
  }

  /** Opens the mic for level metering. Recognition is separate and independent. */
  async openMic(): Promise<boolean> {
    if (this.micAnalyser) return true
    if (!this.ctx || !navigator.mediaDevices?.getUserMedia) return false
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The agent's own voice comes out of the same device; ask the browser
          // to cancel what it can before it reaches either analyser or STT.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch {
      this.cb.onNotice?.('Microphone access was blocked, so you can type instead.')
      return false
    }
    if (this.disposed) {
      this.mic.getTracks().forEach((t) => t.stop())
      return false
    }
    const src = this.ctx.createMediaStreamSource(this.mic)
    this.micAnalyser = this.ctx.createAnalyser()
    this.micAnalyser.fftSize = FFT_SIZE
    this.micAnalyser.smoothingTimeConstant = 0.7
    src.connect(this.micAnalyser)
    // Not connected to destination — metering only. Connecting it would play the
    // visitor's own voice back at them.
    this.micBuf = new Uint8Array(new ArrayBuffer(this.micAnalyser.frequencyBinCount))
    return true
  }

  /**
   * Loudness of whichever side is active, 0..1, for the strand visualiser.
   * RMS rather than peak: peak makes a single consonant look like a shout.
   */
  level(of: 'mic' | 'out'): number {
    const analyser = of === 'mic' ? this.micAnalyser : this.outAnalyser
    const buf = of === 'mic' ? this.micBuf : this.outBuf
    if (!analyser || !buf) return 0
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / buf.length)
    // Speech RMS sits around 0.05–0.25, so scale before clamping or the visual
    // barely moves.
    return Math.min(1, rms * 4.2)
  }

  /* ---------------------------------------------------------- recognition --- */

  startListening(): void {
    if (this.disposed) return
    this.wantListening = true
    if (this.phase === 'speaking') return // resumed when playback finishes
    this.spinUpRecognition()
  }

  private spinUpRecognition(): void {
    if (this.rec || !this.wantListening) return
    const Ctor = recognitionCtor()
    if (!Ctor) return

    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.maxAlternatives = 1

    rec.onstart = () => {
      if (this.phase !== 'speaking' && this.phase !== 'thinking') this.setPhase('listening')
    }

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) this.pending += (this.pending ? ' ' : '') + text.trim()
        else interim += text
      }
      if (interim.trim()) this.cb.onInterim?.(interim.trim())
      if (this.pending) {
        this.cb.onInterim?.(this.pending + (interim.trim() ? ` ${interim.trim()}` : ''))
        this.armTurnEnd()
      }
    }

    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; onend restarts. The other two are
      // worth surfacing, because the visitor can act on them.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantListening = false
        this.cb.onNotice?.('Microphone access was blocked, so you can type instead.')
      }
    }

    rec.onend = () => {
      this.rec = null
      // Chrome ends the session on its own every ~60s of quiet. Restart unless
      // the agent is talking or we're done.
      if (this.wantListening && !this.disposed && this.phase !== 'speaking') {
        setTimeout(() => this.spinUpRecognition(), 250)
      }
    }

    this.rec = rec
    try {
      rec.start()
    } catch {
      // `start()` throws if a previous instance is still winding down. onend
      // will bring the next one up.
      this.rec = null
    }
  }

  private armTurnEnd(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null
      const text = this.pending.trim()
      this.pending = ''
      if (!text) return
      this.cb.onInterim?.('')
      this.awaitingReply = true
      this.setPhase('thinking')
      this.cb.onFinal(text)
    }, TURN_END_MS)
  }

  /** Pauses recognition without forgetting that we want it back. */
  private pauseRecognition(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.pending = ''
    const rec = this.rec
    this.rec = null
    if (rec) {
      rec.onend = null
      try {
        rec.abort()
      } catch {
        /* already gone */
      }
    }
  }

  stopListening(): void {
    this.wantListening = false
    this.pauseRecognition()
    if (this.phase === 'listening') this.setPhase('idle')
  }

  /* --------------------------------------------------------------- speaking --- */

  /**
   * Speaks text, queued so overlapping agent messages play in order.
   * Resolves when this item has been spoken (or skipped).
   */
  speak(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.queue.push(trimmed)
    void this.drain()
  }

  /** Plays a pre-rendered file — the greeting, which must start on tap. */
  speakFile(url: string): void {
    this.queue.push(`file:${url}`)
    void this.drain()
  }

  /**
   * Plays a pre-rendered holding line — "One moment" — while the planner thinks.
   * Goes through the same queue as everything else, so a filler and a reply can
   * never overlap; the reply simply plays next.
   *
   * Skipped rather than queued if anything is already playing or waiting, because
   * a filler that arrives behind a real reply has nothing left to fill and would
   * only delay the conversation.
   *
   * The caller asks twice per slow turn — an opener, then a longer-wait line — and
   * the same guard covers the collision: if the opener is somehow still audible
   * when the second is due, there is no silence to fill, so dropping it is the
   * right answer rather than a missed clip.
   */
  speakFiller(url: string): void {
    if (this.disposed) return
    if (this.queue.length || this.phase === 'speaking') return
    this.fillerPending = true
    this.queue.push(`filler:${url}`)
    void this.drain()
  }

  /**
   * A visitor turn is on its way to the agent. Only needed for typed turns —
   * spoken ones are detected here, in `armTurnEnd`.
   */
  noteTurnSent(): void {
    this.awaitingReply = true
  }

  /**
   * The real reply arrived. Drops a filler that has not started yet — including
   * one still being fetched — but lets an audible one finish.
   *
   * Cutting a playing clip mid-word is more jarring than the second it costs, and
   * the collision window is small by design: the caller waits over a second
   * before asking for a filler, while measured replies take four to six seconds.
   */
  noteReply(): void {
    this.awaitingReply = false
    this.fillerPending = false
    this.stopHoldTone()
    this.queue = this.queue.filter((item) => !item.startsWith('filler:'))
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.disposed) {
        const item = this.queue.shift()!
        const isFiller = item.startsWith('filler:')
        // A filler can be cancelled while the one ahead of it plays, or while its
        // own audio is being fetched. Both are checked — here, and again below
        // once the bytes are in hand.
        if (isFiller && !this.fillerPending) continue
        this.pauseRecognition()
        this.setPhase('speaking')
        try {
          const buf = isFiller
            ? await this.fetchAudio(item.slice(7))
            : item.startsWith('file:')
              ? await this.fetchAudio(item.slice(5))
              : await this.synthesise(item)
          if (isFiller) {
            this.fillerPending = false
            // The reply landed during the fetch. Nothing left to fill.
            if (buf && this.queue.length) continue
          }
          if (buf) await this.play(buf)
        } catch (err) {
          // A missing filler clip is not worth a notice — it is decoration, and
          // the reply behind it is the thing the visitor came for.
          if (isFiller) {
            this.fillerPending = false
            continue
          }
          this.cb.onNotice?.(
            err instanceof VoiceQuietError
              ? err.message
              : `Could not play the reply out loud${err instanceof Error ? ` (${err.message})` : ''}. The text is in the transcript.`,
          )
        }
      }
    } finally {
      this.draining = false
      if (!this.disposed) {
        // After a filler the agent is still thinking, so stay in 'thinking' —
        // dropping to 'listening' would tell the visitor it is their turn and
        // invite them to talk over the reply that is about to arrive.
        if (this.awaitingReply) {
          this.setPhase('thinking')
          if (this.wantListening) this.spinUpRecognition()
        } else if (this.wantListening) {
          this.setPhase('listening')
          this.spinUpRecognition()
        } else {
          this.setPhase('idle')
        }
      }
    }
  }

  private async fetchAudio(url: string): Promise<AudioBuffer | null> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`audio ${res.status}`)
    return this.decode(await res.arrayBuffer())
  }

  private async synthesise(text: string): Promise<AudioBuffer | null> {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      // The voice budget was spent (429) or the endpoint refused us (403). Both
      // carry a sentence written for the visitor, so prefer it over a status
      // code — this is the one failure here they might plausibly cause and can
      // do something about (wait, or keep reading the transcript).
      if (res.status === 429 || res.status === 403) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        if (body?.error) throw new VoiceQuietError(body.error)
      }
      throw new Error(`tts ${res.status}`)
    }
    return this.decode(await res.arrayBuffer())
  }

  private async decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    if (!this.ctx) return null
    // Safari only added the promise form recently; the callback form is the
    // portable one.
    return new Promise<AudioBuffer>((resolve, reject) => {
      this.ctx!.decodeAudioData(bytes, resolve, (e) => reject(e ?? new Error('decode failed')))
    })
  }

  private play(buf: AudioBuffer): Promise<void> {
    if (!this.ctx || !this.outAnalyser) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const src = this.ctx!.createBufferSource()
      src.buffer = buf
      src.connect(this.outAnalyser!)
      this.source = src
      src.onended = () => {
        if (this.source === src) this.source = null
        src.disconnect()
        resolve()
      }
      src.start()
    })
  }

  /** Cuts off playback and drops anything still queued. */
  silence(): void {
    this.queue.length = 0
    const src = this.source
    this.source = null
    if (src) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
    }
  }

  /** Prefetches an audio file so the first tap has nothing to wait for. */
  static prime(url: string): void {
    void fetch(url, { cache: 'force-cache' }).catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    this.wantListening = false
    this.stopHoldTone()
    this.silence()
    this.pauseRecognition()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = null
    this.micAnalyser = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.setPhase('idle')
  }
}
