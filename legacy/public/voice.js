/**
 * Voice in and voice out for the demo.
 *
 * In:  browser SpeechRecognition (free, no round trip, Chrome + iOS Safari).
 * Out: ElevenLabs MP3 via our own /api/tts, so the API key stays server-side.
 *
 * If the TTS proxy is unavailable we fall back to the browser's built-in
 * speech synthesis rather than going silent — a robotic voice still demos the
 * agent, silence demos nothing.
 */

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechInputSupported = Boolean(SpeechRecognitionImpl);

/** Push-to-talk microphone. One utterance per press. */
export class Microphone {
  #recognition = null;

  /**
   * @param {object} handlers
   * @param {(partial: string) => void} handlers.onPartial   live transcript while speaking
   * @param {(final: string) => void}   handlers.onFinal     fired once, on release, if anything was heard
   * @param {(message: string) => void} handlers.onError
   */
  constructor({ onPartial, onFinal, onError }) {
    Object.assign(this, { onPartial, onFinal, onError });
  }

  get active() { return Boolean(this.#recognition); }

  start() {
    if (!SpeechRecognitionImpl) return this.onError('This browser has no speech recognition. Type instead.');
    if (this.#recognition) return;

    const recognition = new SpeechRecognitionImpl();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    // One turn per press: continuous mode keeps the mic hot and picks up the
    // agent's own voice coming out of the speaker.
    recognition.continuous = false;

    let finalText = '';
    recognition.onresult = event => {
      let interim = '';
      for (const result of event.results) {
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      this.onPartial((finalText + interim).trim());
    };
    recognition.onerror = event => {
      // "no-speech" and "aborted" are normal when someone taps the button by
      // accident; surfacing them as errors just adds noise.
      if (event.error !== 'no-speech' && event.error !== 'aborted') this.onError(`Microphone: ${event.error}`);
    };
    recognition.onend = () => {
      this.#recognition = null;
      const spoken = finalText.trim();
      if (spoken) this.onFinal(spoken);
      else this.onPartial('');
    };

    this.#recognition = recognition;
    recognition.start();
  }

  stop() {
    // .stop() still delivers the final result; .abort() would discard it.
    this.#recognition?.stop();
  }
}

/** Speaks agent replies. ElevenLabs first, browser synthesis as a safety net. */
export class Speaker {
  #audio = new Audio();
  #objectUrl = null;
  #useProxy;

  constructor({ agentId, ttsEnabled }) {
    this.agentId = agentId;
    this.#useProxy = ttsEnabled;
    this.#audio.autoplay = false;
  }

  /** Called on the first user gesture: iOS refuses audio until then. */
  unlock() {
    this.#audio.muted = true;
    this.#audio.play().catch(() => {}).finally(() => { this.#audio.muted = false; });
  }

  /**
   * @param {string} text          the agent's reply, verbatim
   * @param {() => void} [onStart] fires when audio actually begins
   * @param {() => void} [onEnd]
   */
  async speak(text, { onStart, onEnd } = {}) {
    const spoken = forSpeech(text);
    if (!spoken) { onEnd?.(); return; }

    this.stop();

    if (this.#useProxy) {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken, agentId: this.agentId }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        this.#objectUrl = URL.createObjectURL(blob);
        this.#audio.src = this.#objectUrl;
        this.#audio.onplay = () => onStart?.();
        this.#audio.onended = this.#audio.onerror = () => { this.#revoke(); onEnd?.(); };
        await this.#audio.play();
        return;
      } catch (err) {
        console.warn('ElevenLabs unavailable, falling back to browser voice:', err.message);
      }
    }

    this.#speakWithBrowser(spoken, { onStart, onEnd });
  }

  #speakWithBrowser(text, { onStart, onEnd }) {
    if (!window.speechSynthesis) { onEnd?.(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.voice = pickBestBrowserVoice();
    utterance.onstart = () => onStart?.();
    utterance.onend = utterance.onerror = () => onEnd?.();
    speechSynthesis.speak(utterance);
  }

  stop() {
    this.#audio.pause();
    this.#audio.currentTime = 0;
    this.#revoke();
    window.speechSynthesis?.cancel();
  }

  #revoke() {
    if (this.#objectUrl) { URL.revokeObjectURL(this.#objectUrl); this.#objectUrl = null; }
  }
}

/**
 * Strip anything a phone caller would never hear. The agent is instructed not
 * to emit URLs or markdown, but a demo shouldn't read "asterisk asterisk" aloud
 * if an instruction ever slips.
 */
function forSpeech(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Prefer a neural en-US voice over the default, which is usually the worst one. */
function pickBestBrowserVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const english = voices.filter(v => v.lang?.startsWith('en'));
  return (
    english.find(v => /Google US English/i.test(v.name)) ??
    english.find(v => /Samantha|Ava|Siri/i.test(v.name)) ??
    english.find(v => v.localService === false) ??
    english[0] ??
    null
  );
}
