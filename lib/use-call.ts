'use client'

/**
 * One hook holding an entire call: the Agentforce transport, browser speech
 * recognition, ElevenLabs playback, the transcript, and the audio levels the
 * visualiser reads.
 *
 * The order in `start()` matters and is the whole trick of this demo. A cold
 * Agentforce planner takes up to 30 seconds to push its first message, so:
 *
 *   1. unlock audio (must be inside the tap — iOS requirement)
 *   2. play the pre-rendered greeting MP3 immediately
 *   3. open the mic
 *   4. only then start the conversation
 *
 * The visitor hears the agent within ~200ms of tapping while the planner is
 * still warming up, and the live greeting that eventually arrives over SSE is
 * dropped by `suppressGreeting` in the transport client.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { AgentforceConversation, type ConversationStatus } from './agentforce-client'
import type { PublicAgent, PublicConfig } from './client-types'
import { isClosingTurn, nextFiller, type FillerManifest } from './fillers'
import { Voice, speechRecognitionSupported, type VoicePhase } from './voice'
import type { StrandsDrive } from '@/components/reactbits/Strands'

export type Turn = {
  id: string
  who: 'visitor' | 'agent'
  text: string
}

export type CallState = {
  status: ConversationStatus
  phase: VoicePhase
  turns: Turn[]
  /** Live partial transcript of what the visitor is saying right now. */
  interim: string
  /** Most recent thing said by either side, for the caption over the strands. */
  caption: string
  /** Non-fatal problem worth a line of UI. Cleared on the next successful step. */
  notice: string | null
  /** Fatal problem: the conversation cannot continue. */
  error: string | null
  micReady: boolean
}

/**
 * How long a turn may go unanswered before the filler speaks.
 *
 * A pause of about two seconds is a normal beat in a conversation and needs no
 * explanation; filling it makes the agent sound nervous. Past that the silence
 * starts reading as a dropped call, and a line about what is being looked up is
 * better than nothing. Measured replies run 4 to 8 seconds, so this still fires
 * on most turns — but the fast ones, like the 0.4s replies the org sometimes
 * manages, now simply arrive.
 */
const FILLER_AFTER_MS = 2500

/**
 * How long after the first filler to bring in the ambient hold tone, if the reply
 * still has not arrived.
 *
 * This used to speak a *second* holding line, which on the first turn of a cold
 * planner — a 25-to-30s wait — fired right behind the first and read as the agent
 * overcompensating for the wait ("Just a moment." … "Bear with me."). Past a few
 * seconds a spoken line stops reassuring and starts sounding nervous, so the tail
 * of a long wait is covered by a soft ambient pad instead (see
 * Voice.startHoldTone). One spoken line, then a tone: the hybrid the demo settled
 * on.
 *
 * Set well clear of the opener rather than as soon as possible: the opener runs
 * close to two seconds, and starting the tone the moment it ends steps on it. 7s
 * leaves a real breath first.
 */
const HOLD_TONE_AFTER_MS = 7000

/** Colours per direction. The visitor is cool, the agent warm. */
const VISITOR_COLORS = ['#22d3ee', '#0ea5e9', '#2563eb', '#38bdf8']
const AGENT_COLORS = ['#a78bfa', '#7c3aed', '#c026d3', '#f472b6']
const IDLE_COLORS = ['#334155', '#475569', '#3f4a5f', '#2b3444']
const THINKING_COLORS = ['#fbbf24', '#f59e0b', '#a78bfa', '#f472b6']

export function useCall(agent: PublicAgent, config: PublicConfig) {
  const [state, setState] = useState<CallState>({
    status: 'idle',
    phase: 'idle',
    turns: [],
    interim: '',
    caption: '',
    notice: null,
    error: null,
    micReady: false,
  })

  const convRef = useRef<AgentforceConversation | null>(null)
  const voiceRef = useRef<Voice | null>(null)
  const logSessionRef = useRef<string | null>(null)
  const turnNoRef = useRef(0)
  /** Timestamp of the visitor's last turn, for the reply-latency figure. */
  const sentAtRef = useRef<number | null>(null)
  /**
   * The template's filler clips, or null if the manifest is missing. Fetched on
   * mount so the first turn does not wait for it; a null manifest simply means
   * no filler, never a broken call.
   */
  const fillersRef = useRef<FillerManifest | null>(null)
  const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdToneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Increments per filler played, so the lines rotate instead of repeating. */
  const fillerTurnRef = useRef(0)

  /**
   * Uniform values the Strands shader reads every frame. A ref, not state:
   * audio level updates ~60×/second and re-rendering the tree that often to
   * move a shader uniform would make the page stutter for no visual gain.
   */
  const driveRef = useRef<StrandsDrive>({})
  const colorsRef = useRef<string[]>(IDLE_COLORS)
  const [colors, setColors] = useState<string[]>(IDLE_COLORS)

  const patch = useCallback((next: Partial<CallState>) => {
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  /* --------------------------------------------------------------- logging --- */
  /* Every log call is fire-and-forget. The conversation is the product; the
     instrumentation must never be able to interrupt it. */

  const log = useCallback((body: Record<string, unknown>) => {
    void fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((r: { sessionId?: string } | null) => {
        if (body.action === 'start' && r?.sessionId) logSessionRef.current = r.sessionId
      })
      .catch(() => {})
  }, [])

  const logTurn = useCallback(
    (who: 'visitor' | 'agent', text: string, latencyMs?: number) => {
      const sessionId = logSessionRef.current
      if (!sessionId) return
      turnNoRef.current += 1
      log({
        action: 'turn',
        sessionId,
        speaker: who,
        text,
        turnNumber: turnNoRef.current,
        ...(latencyMs === undefined ? {} : { latencyMs }),
      })
    },
    [log],
  )

  const addTurn = useCallback(
    (who: 'visitor' | 'agent', text: string) => {
      setState((prev) => ({
        ...prev,
        turns: [...prev.turns, { id: `${who}-${prev.turns.length}-${text.length}`, who, text }],
        caption: text,
        interim: '',
      }))
    },
    [],
  )

  /* ------------------------------------------------------------- the filler --- */

  /*
   * The planner takes four to eight seconds per turn and the platform sends this
   * client nothing at all during it, so a short line is spoken locally from a
   * static MP3. The lines describe the agent looking something up, which is true
   * of every turn; they never say what it has decided — see lib/fillers.ts for
   * why guessing that turned out to be a mistake. A turn that reads as a goodbye
   * gets no filler at all, since nothing is being looked up.
   */

  // Fetched on mount, not on tap: the manifest is under a kilobyte, and the first
  // turn is exactly when there is no time to spare. Shared across templates,
  // since nothing in it is industry-specific.
  useEffect(() => {
    let live = true
    fetch('/fillers/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<FillerManifest>) : null))
      .then((manifest) => {
        if (!live || !manifest) return
        fillersRef.current = manifest
        // Warm the first clip only. The others are fetched on the turn they are
        // needed; being a moment late on turn three costs nothing, whereas
        // prefetching eight files on mount costs every visitor bandwidth.
        if (manifest.openers[0]) Voice.prime(manifest.openers[0].audio)
      })
      .catch(() => {
        // No filler is a worse demo, not a broken one. Stay quiet.
      })
    return () => {
      live = false
    }
  }, [])

  const clearFillerTimer = useCallback(() => {
    if (fillerTimerRef.current) {
      clearTimeout(fillerTimerRef.current)
      fillerTimerRef.current = null
    }
    if (holdToneTimerRef.current) {
      clearTimeout(holdToneTimerRef.current)
      holdToneTimerRef.current = null
    }
    // The tone may already be sounding, not just scheduled — stop it too, so a
    // reply that arrives mid-pad fades it out rather than leaving it droning.
    voiceRef.current?.stopHoldTone()
  }, [])

  /**
   * Speaks one holding line if the agent has not answered within a couple of
   * seconds, and brings in the ambient hold tone if the wait drags on past that.
   *
   * Hybrid on purpose: a single spoken line reassures, but a second spoken line on
   * top of it — which is what a cold-planner first turn used to get — sounds
   * nervous. Past the opener, a soft tone says "still here" without the agent
   * talking to itself. See HOLD_TONE_AFTER_MS.
   *
   * `said` is the visitor's turn, used only to stay quiet on a goodbye. It is not
   * used to choose *which* line plays: the lines are interchangeable on purpose.
   */
  const armFiller = useCallback((said: string) => {
    clearFillerTimer()
    const manifest = fillersRef.current
    // A closing turn ("that's all, thanks") gets a fast sign-off; holding the
    // visitor first is awkward. No spoken line and no tone.
    if (isClosingTurn(said)) return

    fillerTimerRef.current = setTimeout(() => {
      fillerTimerRef.current = null
      const clip = manifest ? nextFiller(manifest.openers, fillerTurnRef.current++) : null
      if (!clip) return
      // The caption says what is being said out loud, so the visitor reading the
      // screen and the visitor listening get the same thing.
      setState((prev) => (prev.caption === clip.text ? prev : { ...prev, caption: clip.text }))
      voiceRef.current?.speakFiller(clip.audio)
    }, FILLER_AFTER_MS)

    // The tail of a long wait: a tone rather than a second spoken line. Fired even
    // when the filler manifest is missing — the tone needs no assets, so a call
    // with no filler audio still gets covered on its slow turns.
    holdToneTimerRef.current = setTimeout(() => {
      holdToneTimerRef.current = null
      voiceRef.current?.startHoldTone()
    }, HOLD_TONE_AFTER_MS)
  }, [clearFillerTimer])

  /* ------------------------------------------------------------- the visual --- */

  // Drives the shader from whichever side is making sound. Runs for the life of
  // the call; the Strands component itself skips work when the tab is hidden.
  useEffect(() => {
    let raf = 0
    /** Smoothed level, so the strands ease rather than flicker per frame. */
    let smooth = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const voice = voiceRef.current
      const phase = voice?.currentPhase ?? 'idle'
      const raw = !voice
        ? 0
        : phase === 'speaking'
          ? voice.level('out')
          : phase === 'listening'
            ? voice.level('mic')
            : 0
      smooth += (raw - smooth) * 0.22

      const want =
        phase === 'speaking'
          ? AGENT_COLORS
          : phase === 'listening'
            ? VISITOR_COLORS
            : phase === 'thinking'
              ? THINKING_COLORS
              : IDLE_COLORS
      if (want !== colorsRef.current) {
        colorsRef.current = want
        setColors(want)
      }

      // Idle and thinking still breathe — a frozen visual reads as a hung app.
      // Thinking pulses on a clock; listening and speaking track real audio.
      const t = performance.now() / 1000
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.6)
      const base = phase === 'thinking' ? 0.22 + breathe * 0.26 : phase === 'idle' ? 0.1 : 0.14

      driveRef.current = {
        intensity: Math.min(1, base + smooth * 0.85),
        amplitude: 0.55 + smooth * 2.3,
        speed: phase === 'speaking' ? 0.7 + smooth * 1.9 : 0.32 + smooth * 1.2,
        thickness: 0.55 + smooth * 0.75,
        waviness: 0.85 + smooth * 1.1,
        glow: 2.2 + smooth * 1.4,
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ------------------------------------------------------------------ start --- */

  const start = useCallback(async () => {
    if (convRef.current) return
    patch({ status: 'connecting', error: null, notice: null })

    const voice = new Voice({
      onInterim: (text) => patch({ interim: text }),
      onFinal: (text) => {
        addTurn('visitor', text)
        logTurn('visitor', text)
        sentAtRef.current = performance.now()
        armFiller(text)
        convRef.current?.send(text).catch((err: unknown) => {
          clearFillerTimer()
          voiceRef.current?.noteReply()
          patch({
            notice: `That did not reach the agent: ${err instanceof Error ? err.message : String(err)}`,
          })
        })
      },
      onPhase: (phase) => patch({ phase }),
      onNotice: (message) => patch({ notice: message }),
    })
    voiceRef.current = voice

    // Inside the tap. The unlock must happen before any await that could push us
    // out of the gesture, or iOS refuses to make sound.
    await voice.unlock()

    // A real call has a connecting beat; this demo had none, because the greeting
    // fired ~200ms after tap and read as a recording that was already running. So
    // play a short connect cue, hold on 'connecting' for a beat, then greet. The
    // greeting is still local audio and still covers the cold planner — it just no
    // longer lands the instant the finger lifts.
    voice.connectCue()
    await new Promise((r) => setTimeout(r, 850))
    voice.speakFile(agent.greetingAudio)

    const conv = new AgentforceConversation({
      scrt2Url: config.scrt2Url,
      orgId: config.orgId,
      esConfigName: agent.esConfigName,
      appName: config.appName,
      suppressGreeting: agent.greeting,
      onAgentMessage: (text) => {
        const latency = sentAtRef.current ? Math.round(performance.now() - sentAtRef.current) : undefined
        sentAtRef.current = null
        // Drop a filler that has not started; one already audible finishes first.
        clearFillerTimer()
        voiceRef.current?.noteReply()
        addTurn('agent', text)
        logTurn('agent', text, latency)
        voiceRef.current?.speak(text)
      },
      onStatus: (status, detail) => {
        // 'error' from the transport means the event stream is gone for good;
        // everything else is a normal transition.
        if (status === 'error') patch({ status, error: detail ?? 'The connection to the agent failed.' })
        else patch({ status, ...(status === 'ready' ? { error: null } : {}) })
      },
      onTyping: () => patch({ phase: 'thinking' }),
    })
    convRef.current = conv

    // The greeting is already playing, so the transcript should show it too.
    addTurn('agent', agent.greeting)

    const micReady = await voice.openMic()
    patch({ micReady })
    if (micReady && speechRecognitionSupported()) {
      voice.startListening()
    } else if (micReady) {
      patch({
        notice: 'This browser cannot transcribe speech, so type your side of the conversation.',
      })
    }

    try {
      await conv.start()
      log({ action: 'start', conversationId: conv.conversationId, agentKey: agent.key })
      logTurn('agent', agent.greeting)
    } catch (err) {
      patch({
        status: 'error',
        error: `Could not reach the agent: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }, [agent, config, patch, addTurn, log, logTurn, armFiller, clearFillerTimer])

  /* ------------------------------------------------------- send / end / mute --- */

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || !convRef.current) return
      addTurn('visitor', trimmed)
      logTurn('visitor', trimmed)
      sentAtRef.current = performance.now()
      patch({ phase: 'thinking' })
      // A typed turn never went through recognition, so Voice has not seen it.
      voiceRef.current?.noteTurnSent()
      armFiller(trimmed)
      convRef.current.send(trimmed).catch((err: unknown) => {
        clearFillerTimer()
        voiceRef.current?.noteReply()
        patch({
          notice: `That did not reach the agent: ${err instanceof Error ? err.message : String(err)}`,
        })
      })
    },
    [addTurn, logTurn, patch, armFiller, clearFillerTimer],
  )

  const end = useCallback(() => {
    clearFillerTimer()
    voiceRef.current?.dispose()
    voiceRef.current = null
    const conv = convRef.current
    convRef.current = null
    void conv?.end()
    // Nothing is logged on hang-up. The turn rows already carry the count and the
    // last timestamp, and a visitor closing the tab — the normal ending — kills the
    // request anyway. See app/api/log/route.ts.
    logSessionRef.current = null
    patch({ status: 'ended', phase: 'idle', interim: '' })
  }, [patch, clearFillerTimer])

  const [muted, setMuted] = useState(false)
  const toggleMute = useCallback(() => {
    const voice = voiceRef.current
    if (!voice) return
    setMuted((prev) => {
      const next = !prev
      if (next) voice.stopListening()
      else voice.startListening()
      return next
    })
  }, [])

  // Hanging up on unmount matters: without it, closing the tab mid-call leaves
  // an open MessagingSession and a live mic track.
  useEffect(() => {
    return () => {
      if (fillerTimerRef.current) clearTimeout(fillerTimerRef.current)
      voiceRef.current?.dispose()
      voiceRef.current = null
      void convRef.current?.end()
      convRef.current = null
    }
  }, [])

  return { state, start, sendText, end, muted, toggleMute, driveRef, colors }
}
