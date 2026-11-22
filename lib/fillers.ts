/**
 * Spoken filler for the planner gap.
 *
 * Agentforce takes four to six seconds of inference per turn, and nothing at all
 * reaches this client while it thinks: on a `deploymentType: API` MIAW client the
 * event router emits no progress frame of any kind (verified with
 * scripts/dump-frames.mjs across four unfiltered runs, including turns that fired
 * Apex). TypingStartedIndicator carries no text, and `capabilitiesVersion` 2/3/4
 * return 400. So the filler is spoken locally from static MP3s, pre-rendered by
 * scripts/render-fillers.mjs.
 *
 * What it says is deliberately generic, and that is the whole design.
 *
 * The first version of this module spoke each action's authored
 * `progress_indicator_message` — "Booking the visit", "Checking the schedule" —
 * choosing between them by keyword-matching the visitor's words. It was wrong,
 * and no amount of tuning could make it right. Those strings are written to be
 * displayed *while an action executes*, when "Booking the visit" is a true
 * statement. Spoken *before* the planner has decided anything, they assert a
 * decision that has not been made. "I'd like to book an appointment" matched
 * `book_appointment` correctly and confidently — and the agent's actual next move
 * was to ask which slot, so "Booking the visit" was a lie told in a confident
 * voice. A filler that contradicts the reply behind it is worse than silence.
 *
 * So there is nothing to guess. These lines are true of every turn of every
 * template no matter what the planner decides, which is why they are shared
 * across all industries rather than derived per agent.
 *
 * What the lines *can* do, and now do, is say what the agent is doing rather
 * than only that it is busy. "One moment." told the visitor nothing, and landed
 * as an odd little interruption when they had just read out their address. "Let
 * me look that up for you, one second." describes the agent's own act of
 * looking, which is true whatever it decides afterwards.
 *
 * The one turn where even that is wrong is the goodbye: nothing is being looked
 * up, and holding the visitor for a second before "thanks for calling" is worse
 * than answering plainly. `isClosingTurn` below suppresses the filler there. It
 * is a suppression, not a prediction — when it is wrong the visitor gets quiet,
 * which is the same thing they got before any of this existed.
 */

export type FillerClip = {
  /** Stable id, used as the MP3 filename. */
  id: string
  /** What is spoken. Also shown as the caption, so both sides say the same thing. */
  text: string
  /** Path to the pre-rendered MP3 under public/. */
  audio: string
  /** Fingerprint of text + voice. Used by the render script, not at run time. */
  stamp: string
}

export type FillerManifest = {
  /** Spoken about a second into the wait. */
  openers: FillerClip[]
  /** Spoken if the wait keeps going. Phrased as continuing, not starting. */
  waits: FillerClip[]
}

/**
 * Picks the next line, rotating so a visitor on turn four does not hear the same
 * recording for the fourth time. Rotation rather than randomness: it guarantees
 * no immediate repeat, where random selection would sometimes repeat twice in a
 * row and sound broken.
 *
 * `turn` is any counter that increases once per use; callers keep it for the life
 * of the call.
 */
export function nextFiller(clips: FillerClip[], turn: number): FillerClip | null {
  if (!clips.length) return null
  // Modulo of a possibly-negative or non-integer counter would index out of
  // bounds, so normalise rather than trust the caller.
  const i = Math.abs(Math.floor(turn)) % clips.length
  return clips[i] ?? null
}

/**
 * Ways a visitor signals they are finished. Each needs a word specific to
 * ending — "all set", "that's everything", "goodbye" — because the reply to one
 * of these is a sign-off, and "let me look that up" ahead of "thanks for
 * calling" is the exact thing that sounded wrong.
 *
 * Deliberately not a bare "no" or "nope". Those answer questions mid-call at
 * least as often as they end one ("is this commercial?" — "no"), and those turns
 * do run a lookup.
 */
const CLOSING = [
  /\b(good ?bye|bye bye|bye now)\b/,
  /^(bye|thanks|thank you|thanks a lot|thank you so much|cheers)[.!]?$/,
  /\b(that'?s|that is|thats) (all|it|everything|fine)\b/,
  /\b(that'?ll|that will) be (all|it)\b/,
  /\bnothing (else|more)\b/,
  /\b(we'?re|i'?m|were|im) (all )?(good|set|done)\b/,
  /\b(all set|all good|all done)\b/,
  /\bno(,| ) ?thank(s| you)\b/,
  /\bhave a (good|great|nice)\b/,
  /\bappreciate (it|your help)\b/,
]

/**
 * True when a visitor's turn reads as ending the call, so the filler should stay
 * quiet. The reply to a goodbye is a goodbye, and it arrives fast; holding the
 * visitor with "let me look that up" first is the awkwardness this removes.
 *
 * Length-capped because these phrases also appear inside real requests — "thanks,
 * my furnace is done for and nothing else in the house is heating" is not a
 * goodbye. A closing turn is a handful of words; anything longer is a request
 * that happens to be polite, and gets the filler as usual.
 *
 * Wrong in the safe direction either way. A missed closing is one stray "one
 * second" (what happens today), and a false positive is a second of quiet before
 * a normal reply.
 */
export function isClosingTurn(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!t) return false
  if (t.split(' ').length > 8) return false
  return CLOSING.some((pattern) => pattern.test(t))
}
