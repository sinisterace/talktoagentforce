#!/usr/bin/env node
/**
 * Measures what the visitor actually waits for, in a real browser, against a
 * deployed build.
 *
 * scripts/dump-frames.mjs measures the transport in isolation. This measures the
 * whole perceived chain — tap to first audible word, and typed turn to audible
 * reply — including the parts only the browser does: fetching and decoding the
 * TTS MP3, and the queue in lib/voice.ts. Speech recognition is not driven here
 * (headless Chromium has no Web Speech backend), so turns are typed; the
 * TURN_END_MS pause a real speaker waits through is added on top of these
 * numbers.
 *
 * Usage:
 *   node scripts/measure-call-latency.mjs
 *   node scripts/measure-call-latency.mjs --url http://localhost:3000
 */

import { chromium } from 'playwright'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i]
}
const URL = args.url ?? process.env.APP_URL ?? 'http://localhost:3000'
const TURNS = (args.say ?? 'my furnace stopped working and it is freezing|no gas smell, no alarms')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean)

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  permissions: ['microphone'],
})
const page = await ctx.newPage()

/** Timeline of interesting things, all relative to the tap. */
const marks = []
let tapAt = 0
const mark = (label) => marks.push({ label, t: Date.now() - tapAt })

// Instrument the two things that tell us when sound actually starts: the TTS
// round trip, and the greeting file fetch. Both are observable as requests.
page.on('response', (res) => {
  const u = res.url()
  if (!tapAt) return
  if (u.includes('/api/tts')) mark(`tts response ${res.status()}`)
  else if (u.includes('/greetings/')) mark(`greeting mp3 ${res.status()}`)
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console error] ${m.text().slice(0, 160)}`)
})

await page.goto(URL, { waitUntil: 'networkidle' })

// Patch AudioBufferSourceNode.start so we learn the instant audio is truly
// audible, plus the clip's duration — the transport timings say nothing about
// how long the visitor then sits listening.
await page.addInitScript(() => {})
await page.evaluate(() => {
  window.__audio = []
  const orig = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__audio.push({ at: Date.now(), duration: this.buffer ? this.buffer.duration : null })
    return orig.apply(this, a)
  }
})

await page.getByRole('button', { name: /HVAC/i }).first().click()
await page.waitForTimeout(600)

const callBtn = page.getByRole('button', { name: /^Call the/i })
await callBtn.waitFor({ timeout: 15000 })

tapAt = Date.now()
await callBtn.click()

// Wait for the greeting to be audible.
await page.waitForFunction(() => window.__audio.length > 0, null, { timeout: 30000 })
const greeting = await page.evaluate(() => window.__audio[0])
console.log(`\ntap → greeting audible:        ${greeting.at - tapAt}ms`.replace('tapAt', '') )
console.log(`  greeting clip length:        ${greeting.duration?.toFixed(2)}s`)

const composer = page.getByPlaceholder(/type instead/i)
await composer.waitFor({ timeout: 30000 })

let clipCount = 1
for (const text of TURNS) {
  await composer.fill(text)
  const sentAt = Date.now()
  await composer.press('Enter')
  clipCount += 1
  try {
    await page.waitForFunction((n) => window.__audio.length >= n, clipCount, { timeout: 60000 })
  } catch {
    console.log(`\n"${text}"\n  NO AUDIBLE REPLY within 60s`)
    continue
  }
  const clip = await page.evaluate((n) => window.__audio[n - 1], clipCount)
  console.log(`\n"${text}"`)
  console.log(`  send → reply audible:        ${clip.at - sentAt}ms`)
  console.log(`  reply clip length:           ${clip.duration?.toFixed(2)}s`)
}

console.log('\nnetwork marks (ms after tap):')
for (const m of marks) console.log(`  ${String(m.t).padStart(7)}  ${m.label}`)

const shot = '/tmp/call-latency.png'
await page.screenshot({ path: shot })
console.log(`\nscreenshot ${shot}\n`)

await browser.close()
