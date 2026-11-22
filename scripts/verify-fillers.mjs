#!/usr/bin/env node
/**
 * Confirms, in a real browser, that the filler is audible while the planner
 * thinks and that the reply still plays cleanly behind it.
 *
 * scripts/measure-call-latency.mjs cannot answer this: it identifies the reply by
 * counting AudioBufferSourceNode starts, and a filler adds one, so it would time
 * the filler and call it the reply. This script instead labels every clip by
 * where its bytes came from — /fillers/ or /api/tts — and prints the timeline.
 *
 * What a good run looks like, per turn:
 *   ~2.2s   filler   ("Let me pull that up, one second.", from /fillers/)
 *   ~4-8s   reply    (from /api/tts, starting after the filler has finished)
 * and no overlap between the two, since both go through the same queue.
 *
 * A second filler is armed for 6.5s and normally never plays, because the reply
 * beats it. On a slow turn it does, and two fillers before the reply is a pass —
 * the checks below look at the first one.
 *
 * The turns sent here are deliberately mid-call requests. A turn that reads as a
 * goodbye gets no filler at all by design (`isClosingTurn`), so passing one in
 * with --say would fail the "no filler played" check for the right reason.
 *
 * Speech recognition has no backend in headless Chromium, so turns are typed.
 * That exercises the same path — sendText calls noteTurnSent then armFiller — but
 * it can do something a speaker cannot: submit a turn while the agent is still
 * talking, which `speakFiller` deliberately skips. So each turn here waits for
 * playback to finish first, the way a real visitor is forced to by the mic being
 * paused during playback.
 *
 * Usage:
 *   node scripts/verify-fillers.mjs --url http://localhost:3111
 */

import { chromium } from 'playwright'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i]
}
const URL = args.url ?? 'http://localhost:3111'
const TURNS = (args.say ?? 'my furnace stopped working and it is freezing|I need to reschedule my appointment')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean)

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['microphone'],
})
const page = await ctx.newPage()

page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console error] ${m.text().slice(0, 160)}`)
})

await page.goto(URL, { waitUntil: 'networkidle' })

// Label each played clip by the URL its bytes were decoded from. decodeAudioData
// is the join point: every clip, whether a static file or a TTS response, passes
// through it, and the fetch immediately before it is its source.
await page.evaluate(() => {
  window.__clips = []
  window.__lastUrl = null

  // Counted so waitForSilence can tell "the agent has finished" from "the agent's
  // next clip is still being synthesised". Only the first is silence.
  window.__inflight = 0

  const origFetch = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    const audio = url.includes('/fillers/') || url.includes('/api/tts')
    if (audio) {
      window.__lastUrl = url
      window.__inflight++
    }
    const done = origFetch.call(this, input, init)
    return audio ? done.finally(() => window.__inflight--) : done
  }

  const origDecode = AudioContext.prototype.decodeAudioData
  const pending = new WeakMap()
  AudioContext.prototype.decodeAudioData = function (bytes, onOk, onErr) {
    const url = window.__lastUrl
    return origDecode.call(
      this,
      bytes,
      (buf) => {
        pending.set(buf, url)
        onOk?.(buf)
      },
      onErr,
    )
  }

  const origStart = AudioBufferSourceNode.prototype.start
  AudioBufferSourceNode.prototype.start = function (...a) {
    const url = this.buffer ? pending.get(this.buffer) : null
    window.__clips.push({
      at: Date.now(),
      duration: this.buffer ? this.buffer.duration : null,
      url: url ?? '(unknown)',
      kind: !url ? 'unknown' : url.includes('/fillers/') ? 'filler' : url.includes('/greetings/') ? 'greeting' : 'reply',
    })
    return origStart.apply(this, a)
  }
})

await page.getByRole('button', { name: /HVAC/i }).first().click()
const callBtn = page.getByRole('button', { name: /^Call the/i })
await callBtn.waitFor({ timeout: 15000 })
await callBtn.click()

const composer = page.getByPlaceholder(/type instead/i)
await composer.waitFor({ timeout: 30000 })

/**
 * Blocks until nothing is playing, so the next turn starts from silence. Without
 * this the script types over the agent and `speakFiller` skips the filler by
 * design, which reads as a failure but is correct behaviour.
 *
 * Two conditions, because the agent sometimes answers one turn with two Message
 * frames. The second clip is queued but inaudible until its own TTS round trip
 * returns, so playback stopping does not mean the turn is over — hence the
 * in-flight check. Without it that straggler starts inside the next turn and is
 * timed as an impossibly fast reply, which fails the run about one time in three.
 * The 1500ms grace covers the window between a clip ending and the next fetch
 * being issued.
 */
async function waitForSilence() {
  await page.waitForFunction(
    () => {
      if (window.__inflight > 0) return false
      const last = window.__clips[window.__clips.length - 1]
      if (!last) return true
      return Date.now() >= last.at + (last.duration ?? 0) * 1000 + 1500
    },
    null,
    { timeout: 90000 },
  )
}

// The greeting is playing; let it land so it cannot be mistaken for turn audio.
await page.waitForFunction(() => window.__clips.length > 0, null, { timeout: 30000 })
await waitForSilence()

let failures = 0
for (const text of TURNS) {
  const before = await page.evaluate(() => window.__clips.length)
  await composer.fill(text)
  const sentAt = Date.now()
  await composer.press('Enter')
  await page.evaluate((t) => (window.__sentAt = t), sentAt)

  // Wait for a reply, not just for any clip — the filler arrives first.
  try {
    await page.waitForFunction(
      (n) => window.__clips.slice(n).some((c) => c.kind === 'reply'),
      before,
      { timeout: 60000 },
    )
  } catch {
    console.log(`\n"${text}"\n  FAIL no reply audio within 60s`)
    failures++
    continue
  }

  const clips = await page.evaluate((n) => window.__clips.slice(n), before)
  console.log(`\n"${text}"`)
  for (const c of clips) {
    console.log(
      `  ${String(c.at - sentAt).padStart(6)}ms  ${c.kind.padEnd(8)} ${c.duration?.toFixed(2)}s  ${c.url.replace(URL, '')}`,
    )
  }

  const filler = clips.find((c) => c.kind === 'filler')
  const reply = clips.find((c) => c.kind === 'reply')

  if (!filler) {
    console.log('  FAIL no filler played — the reply beat FILLER_AFTER_MS, or the manifest did not load')
    failures++
  } else {
    const lateBy = filler.at - sentAt
    // 2200ms armed, plus the fetch and decode of a ~30KB local file.
    if (lateBy < 2100 || lateBy > 3600) {
      console.log(`  FAIL filler started ${lateBy}ms after the turn, expected roughly 2200-3000ms`)
      failures++
    }
    // Both go through the same queue, so the reply must not start until the
    // filler has finished. An overlap means the queue was bypassed.
    const fillerEnds = filler.at + filler.duration * 1000
    if (reply.at < fillerEnds - 150) {
      console.log(`  FAIL reply overlapped the filler by ${Math.round(fillerEnds - reply.at)}ms`)
      failures++
    }
  }

  await waitForSilence()
}

/*
 * The goodbye, checked last because it ends the conversation.
 *
 * This is the turn the user reported: the agent used to say "one moment" and then
 * sign off. Nothing is being looked up on a closing turn, so the filler must stay
 * quiet — and unlike the checks above, silence here is the pass.
 *
 * Waits the full FILLER_AFTER_MS plus the fetch and decode of a local file before
 * looking, otherwise it would pass simply by checking too early.
 */
{
  const text = "no that's all, thanks"
  const before = await page.evaluate(() => window.__clips.length)
  await composer.fill(text)
  const sentAt = Date.now()
  await composer.press('Enter')

  await page.waitForTimeout(3600)
  const early = await page.evaluate((n) => window.__clips.slice(n), before)
  console.log(`\n"${text}"`)
  for (const c of early) {
    console.log(`  ${String(c.at - sentAt).padStart(6)}ms  ${c.kind.padEnd(8)} ${c.url.replace(URL, '')}`)
  }
  const spoke = early.find((c) => c.kind === 'filler')
  if (spoke) {
    console.log(`  FAIL a filler played on a closing turn (${spoke.url.replace(URL, '')})`)
    failures++
  } else {
    console.log('  ok     no filler on a closing turn')
  }
}

console.log(failures === 0 ? '\nfiller behaviour verified' : `\n${failures} check(s) failed`)
await page.screenshot({ path: '/tmp/verify-fillers.png' })
await browser.close()
process.exit(failures === 0 ? 0 : 1)
