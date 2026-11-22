#!/usr/bin/env node
/**
 * Where do the seconds before the first greeting actually go?
 *
 * Same four calls as the real client, but prints EVERY SSE frame with a
 * timestamp and its entryType. The event sequence tells you whether the delay is
 * Omni-Channel routing (nothing on the wire at all), the agent joining
 * (ParticipantChanged), or the agent's first LLM turn (TypingStartedIndicator
 * then Message).
 *
 * Usage:
 *   node scripts/diagnose-greeting-latency.mjs
 *   node scripts/diagnose-greeting-latency.mjs --runs 3
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[++i]
}

const SCRT2 = process.env.SF_SCRT2_URL.replace(/\/$/, '')
const ORG_ID = process.env.SF_ORG_ID.slice(0, 15)
const APP_NAME = process.env.SF_MIAW_APP_NAME ?? 'heroku_demo'
const ES_CONFIG = args.esconfig ?? 'HVAC_Service_Api'
const RUNS = Number(args.runs ?? 1)

const results = []

for (let run = 1; run <= RUNS; run++) {
  console.log(`\n${'='.repeat(70)}\nRUN ${run} of ${RUNS}\n${'='.repeat(70)}`)
  const t0 = Date.now()
  const at = () => `${String(((Date.now() - t0) / 1000).toFixed(2)).padStart(7)}s`
  const marks = {}

  const tokenRes = await fetch(`${SCRT2}/iamessage/api/v2/authorization/unauthenticated/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgId: ORG_ID,
      esDeveloperName: ES_CONFIG,
      capabilitiesVersion: '1',
      platform: 'Web',
      context: { appName: APP_NAME, clientVersion: '1.0.0' },
    }),
  })
  const { accessToken } = await tokenRes.json()
  marks.token = Date.now() - t0
  console.log(`${at()}  token`)

  const abort = new AbortController()
  let firstMessage = null
  let sseReady
  const sseOpen = new Promise((r) => { sseReady = r })

  ;(async () => {
    const res = await fetch(`${SCRT2}/eventrouter/v1/sse`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/event-stream', 'X-Org-Id': ORG_ID },
      signal: abort.signal,
    })
    marks.sse = Date.now() - t0
    console.log(`${at()}  SSE open`)
    sseReady()

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        // Print the SSE event name too — routing lifecycle events arrive under
        // their own event types, not as conversation entries.
        const evLine = frame.split('\n').find((l) => l.startsWith('event:'))
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        const ev = evLine ? evLine.slice(6).trim() : '(none)'
        if (!dataLine) { console.log(`${at()}  event ${ev} (no data)`); continue }

        let parsed
        try { parsed = JSON.parse(dataLine.slice(5).trim()) } catch { console.log(`${at()}  event ${ev} (unparsed)`); continue }

        const entry = parsed.conversationEntry
        if (!entry) { console.log(`${at()}  event ${ev} → ${JSON.stringify(parsed).slice(0, 120)}`); continue }

        let payload = {}
        try { payload = JSON.parse(entry.entryPayload) } catch {}
        const type = payload.entryType ?? '?'
        const role = entry.sender?.role ?? '?'
        let extra = ''
        if (type === 'Message') extra = ` "${(payload.abstractMessage?.staticContent?.text ?? '').slice(0, 60)}"`
        if (type === 'ParticipantChanged') extra = ` ${JSON.stringify(payload.entries?.map((e) => `${e.operation}:${e.participant?.role}`) ?? [])}`
        if (type === 'RoutingResult') extra = ` ${payload.routingType ?? ''} ${payload.failureType ?? ''}`
        console.log(`${at()}  event ${ev} | ${type} from ${role}${extra}`)

        if (type === 'Message' && role !== 'EndUser' && firstMessage === null) {
          firstMessage = Date.now() - t0
        }
      }
    }
  })().catch((e) => { if (e.name !== 'AbortError') console.error('sse:', e.message) })

  await sseOpen

  const convId = crypto.randomUUID()
  const convRes = await fetch(`${SCRT2}/iamessage/api/v2/conversation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, esDeveloperName: ES_CONFIG }),
  })
  marks.conversation = Date.now() - t0
  console.log(`${at()}  conversation ${convRes.status}`)

  const until = Date.now() + 90000
  while (firstMessage === null && Date.now() < until) await new Promise((r) => setTimeout(r, 100))

  await fetch(`${SCRT2}/iamessage/api/v2/conversation/${convId}?esDeveloperName=${ES_CONFIG}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {})
  abort.abort()

  results.push({ run, convId, ...marks, greeting: firstMessage })
  console.log(`\n  greeting at ${firstMessage === null ? 'NEVER' : (firstMessage / 1000).toFixed(2) + 's'}`)

  if (run < RUNS) await new Promise((r) => setTimeout(r, 3000))
}

console.log(`\n${'='.repeat(70)}\nSUMMARY (ms)\n${'='.repeat(70)}`)
console.log('run  token   sse   conv   greeting   conversationId')
for (const r of results) {
  console.log(
    `${String(r.run).padEnd(4)} ${String(r.token).padStart(5)} ${String(r.sse).padStart(5)} ${String(r.conversation).padStart(6)} ${String(r.greeting ?? 'none').padStart(10)}   ${r.convId}`,
  )
}
process.exit(0)
