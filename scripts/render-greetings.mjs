#!/usr/bin/env node
/**
 * Pre-render every template's greeting to a static MP3 in public/greetings/.
 *
 * Why this exists: the greeting is the same sentence for every visitor forever,
 * but Agentforce needs up to 30 seconds to push it when the planner is cold.
 * Waiting for it means the visitor taps and hears nothing. Playing a file that
 * was rendered weeks ago means they hear it instantly, cold or warm, and the
 * copy that eventually arrives over SSE is suppressed by the client.
 *
 * It also stops ElevenLabs being billed for the same sentence on every single
 * session, which on short demo conversations is a large share of the spend.
 *
 * Usage:
 *   node scripts/render-greetings.mjs              # only missing/changed files
 *   node scripts/render-greetings.mjs --force      # re-render everything
 *   node scripts/render-greetings.mjs --check      # verify only, render nothing
 *
 * Run it after changing a `greeting` in lib/agents.ts, after adding a template,
 * and after changing ELEVENLABS_VOICE_ID. Commit the MP3s — they are build
 * inputs, not build output, and Heroku must not need an API key to serve them.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(REPO, 'public', 'greetings')
const BUNDLES = join(REPO, 'salesforce', 'force-app', 'main', 'default', 'aiAuthoringBundles')

// Runs outside Next, which is what normally loads .env.
for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const CHECK_ONLY = args.has('--check')

// Node strips the type annotations, so the registry is the single source of truth
// rather than a copy that drifts.
const { AGENTS } = await import(join(REPO, 'lib', 'agents.ts'))

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'UgBBYS2sOqTuMpoF3BR0'
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5'

// ------------------------------------------------------- drift check vs .agent

/**
 * The client suppresses the live greeting by string-matching it against
 * `greeting` in lib/agents.ts. If someone edits the .agent file's welcome
 * message and not the registry, the visitor hears the greeting twice — once
 * from the MP3 and once from Agentforce. Catch that here instead.
 */
function welcomeMessages() {
  const found = new Set()
  if (!existsSync(BUNDLES)) return found
  for (const bundle of readdirSync(BUNDLES)) {
    const file = join(BUNDLES, bundle, `${bundle}.agent`)
    if (!existsSync(file)) continue
    const m = readFileSync(file, 'utf8').match(/^\s*welcome:\s*"(.*)"\s*$/m)
    if (m) found.add(m[1])
  }
  return found
}

const welcomes = welcomeMessages()
let drifted = 0
for (const a of AGENTS) {
  if (welcomes.size === 0) break // no local bundles to compare against
  if (!a.greeting) continue // roadmap tile, not yet built — nothing to match or render
  if (welcomes.has(a.greeting)) continue
  drifted++
  console.error(`DRIFT  ${a.key}: greeting in lib/agents.ts matches no welcome: in any .agent file`)
  console.error(`         registry: "${a.greeting}"`)
}
if (drifted) {
  console.error('\nFix the mismatch before rendering, or the visitor hears the greeting twice.')
  process.exit(1)
}

// ------------------------------------------------------------------- rendering

/** Fingerprints the text and the voice, so a voice change re-renders too. */
function stamp(text) {
  return createHash('sha256').update(`${VOICE_ID}\n${MODEL_ID}\n${text}`).digest('hex').slice(0, 16)
}

mkdirSync(OUT_DIR, { recursive: true })

let rendered = 0
let skipped = 0
for (const agent of AGENTS) {
  if (!agent.greeting) continue // roadmap tile, not yet built — nothing to render
  const mp3 = join(OUT_DIR, `${agent.key}.mp3`)
  const sidecar = join(OUT_DIR, `${agent.key}.sha`)
  const want = stamp(agent.greeting)
  const have = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : null

  if (!FORCE && existsSync(mp3) && have === want) {
    console.log(`ok       ${agent.key}.mp3 up to date`)
    skipped++
    continue
  }

  if (CHECK_ONLY) {
    console.error(`STALE    ${agent.key}.mp3 needs rendering`)
    rendered++
    continue
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('ELEVENLABS_API_KEY is not set, and one or more greetings need rendering.')
    process.exit(1)
  }

  // Same voice_settings as app/api/tts/route.ts, so the pre-rendered greeting
  // and the live replies sound like one voice rather than two.
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
        text: agent.greeting,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.65, similarity_boost: 0.75, speed: 1 },
      }),
    },
  )
  if (!res.ok) {
    console.error(`FAILED   ${agent.key}: ElevenLabs returned ${res.status} ${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }

  const audio = Buffer.from(await res.arrayBuffer())
  writeFileSync(mp3, audio)
  writeFileSync(sidecar, `${want}\n`)
  console.log(`rendered ${agent.key}.mp3  ${(audio.length / 1024).toFixed(1)} KB`)
  rendered++
}

if (CHECK_ONLY) {
  if (rendered) {
    console.error(`\n${rendered} greeting(s) stale. Run: node scripts/render-greetings.mjs`)
    process.exit(1)
  }
  console.log(`\nAll ${skipped} greeting(s) current.`)
} else {
  console.log(`\n${rendered} rendered, ${skipped} unchanged. Files in public/greetings/.`)
}
