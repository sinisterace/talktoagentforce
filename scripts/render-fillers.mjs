#!/usr/bin/env node
/**
 * Pre-renders the short lines the agent speaks while the planner thinks, into
 * public/fillers/, plus a manifest the browser reads at call time.
 *
 * Why this exists: Agentforce takes four to six seconds of planner inference per
 * turn, and nothing reaches this client during it. On a `deploymentType: API`
 * MIAW client the event router emits no progress frame of any kind (verified with
 * scripts/dump-frames.mjs across four unfiltered runs, including turns that fired
 * Apex), TypingStartedIndicator carries no text field, and `capabilitiesVersion`
 * 2/3/4 all return 400. Without this the visitor hears five seconds of silence
 * after every single thing they say, which reads as a dropped call.
 *
 * Static files rather than /api/tts, for the same two reasons as the greeting: a
 * filler that has to wait on a TTS round trip is not filler, and these are the
 * most-played clips in the app, so paying ElevenLabs per play would make them the
 * largest line on the bill. Rendered once, served free forever.
 *
 * Why the lines are generic, and why they are not per-agent: an earlier version
 * rendered each action's authored `progress_indicator_message` ("Booking the
 * visit", "Checking the schedule") and keyword-matched the visitor's words to
 * choose between them. Those strings are written to narrate an action that is
 * *already running*. Spoken before the planner has decided anything they assert a
 * decision that has not been made — "I'd like to book an appointment" matched
 * `book_appointment` correctly, and the agent then asked which slot, making
 * "Booking the visit" a confident lie. See lib/fillers.ts for the full account.
 * These lines instead hold true whatever the planner does next, so there is
 * nothing to guess and nothing to configure per industry.
 *
 * Usage:
 *   node scripts/render-fillers.mjs              # only missing/changed clips
 *   node scripts/render-fillers.mjs --force      # re-render everything
 *   node scripts/render-fillers.mjs --check      # verify only, render nothing
 *
 * Commit the MP3s and the manifest. They are build inputs, not build output —
 * Heroku must not need an ElevenLabs key to serve them.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(REPO, 'public', 'fillers')
const MANIFEST = join(OUT_DIR, 'manifest.json')

// Runs outside Next, which is what normally loads .env.
if (existsSync(join(REPO, '.env'))) {
  for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const CHECK_ONLY = args.has('--check')

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'UgBBYS2sOqTuMpoF3BR0'
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5'

/**
 * Said once the wait has gone past a couple of seconds.
 *
 * Every line has to be true no matter what the agent says next — whether it books
 * something, asks a clarifying question, or refuses. What the planner is always
 * doing is looking at what it knows and working out a reply, so lines about
 * *looking* are safe. "Booking your visit" is not, because it commits the agent
 * to an outcome it has not chosen yet.
 *
 * Each line names the act, not just the delay. "One moment." was the old opener
 * and it was the complaint: it tells the visitor nothing, so it reads as the
 * agent stalling, and it landed oddly right after they had read out an address.
 * "Let me pull that up, one second." says what the pause is for, which is what a
 * person on a real call would say.
 *
 * Kept to one short clause, and no longer. These play inside a four-to-seven
 * second gap, and a clip that runs three seconds is still talking when the reply
 * lands, which delays the reply behind it.
 */
const OPENERS = [
  'Let me pull that up, one second.',
  'Okay, let me check our system on that.',
  'Give me just a moment to look at that.',
  'Let me find that for you.',
]

/**
 * Said if the wait keeps going past the first clip.
 *
 * Phrased as continuing rather than starting, so that hearing an opener and then
 * one of these sounds like one person waiting with you instead of two unrelated
 * recordings. Each also acknowledges the wait, which is what a person would do at
 * this point in a real call.
 */
const WAITS = [
  'Still looking, thanks for waiting.',
  'Almost there, bear with me.',
  'Just finishing that up.',
  'Nearly done, one more second.',
]

/** Fingerprints text and voice, so a voice or wording change re-renders. */
function stamp(text) {
  return createHash('sha256').update(`${VOICE_ID}\n${MODEL_ID}\n${text}`).digest('hex').slice(0, 16)
}

/** `Let me check on that.` → `let-me-check-on-that`, the MP3 filename. */
function idFor(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

async function render(text, file) {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('ELEVENLABS_API_KEY is not set, and one or more fillers need rendering.')
    process.exit(1)
  }
  // Same voice_settings as app/api/tts/route.ts and render-greetings.mjs, so the
  // filler, the greeting and the live reply are audibly one voice.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.65, similarity_boost: 0.75, speed: 1 },
      }),
    },
  )
  if (!res.ok) {
    console.error(`FAILED   ElevenLabs returned ${res.status} ${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }
  const audio = Buffer.from(await res.arrayBuffer())
  writeFileSync(file, audio)
  return audio.length
}

/* ----------------------------------------------------------------- main --- */

const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null
const had = new Map()
for (const clip of [...(previous?.openers ?? []), ...(previous?.waits ?? [])]) had.set(clip.id, clip)

if (!CHECK_ONLY) mkdirSync(OUT_DIR, { recursive: true })

let rendered = 0
let current = 0
let stale = 0

async function build(texts) {
  const out = []
  for (const text of texts) {
    const id = idFor(text)
    const mp3 = join(OUT_DIR, `${id}.mp3`)
    const want = stamp(text)

    if (!FORCE && existsSync(mp3) && had.get(id)?.stamp === want) {
      current++
    } else if (CHECK_ONLY) {
      console.error(`STALE    ${id}.mp3 needs rendering`)
      stale++
    } else {
      const bytes = await render(text, mp3)
      console.log(`rendered ${id}.mp3  ${(bytes / 1024).toFixed(1)} KB  "${text}"`)
      rendered++
    }

    out.push({
      id,
      text,
      audio: `/fillers/${id}.mp3`,
      // The client never reads this; it is here so the manifest doubles as the
      // freshness index and there is no second sidecar file per clip.
      stamp: want,
    })
  }
  return out
}

const manifest = { openers: await build(OPENERS), waits: await build(WAITS) }
const json = `${JSON.stringify(manifest, null, 2)}\n`

if (CHECK_ONLY) {
  if (existsSync(MANIFEST) && readFileSync(MANIFEST, 'utf8') !== json) {
    console.error('STALE    public/fillers/manifest.json differs from the lines in this script')
    stale++
  }
  if (stale) {
    console.error(`\n${stale} filler asset(s) stale. Run: npm run fillers`)
    process.exit(1)
  }
  console.log(`\nAll ${current} filler clip(s) current.`)
} else {
  writeFileSync(MANIFEST, json)
  console.log(
    `\n${rendered} rendered, ${current} unchanged. ${manifest.openers.length} openers + ${manifest.waits.length} waits in public/fillers/.`,
  )
}
