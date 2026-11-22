#!/usr/bin/env node
/**
 * Prints every SSE frame the scrt2 event router sends, raw and timestamped.
 *
 * scripts/smoke-transport.mjs only surfaces `entryType: Message`, which is what
 * the production client does too — so anything else the platform pushes is
 * invisible in both. This script drops that filter. Use it to answer two
 * questions the filtered view cannot:
 *
 *   1. Where does the latency actually go — token, conversation open, routing,
 *      or the planner's inference?
 *   2. Do the agent's `progress_indicator_message` values arrive over the wire
 *      at all, and if so under what entryType and payload shape?
 *
 * Usage:
 *   node scripts/dump-frames.mjs
 *   node scripts/dump-frames.mjs --say "my furnace stopped working"
 *   node scripts/dump-frames.mjs --say "a|b|c" --wait 60      # pipe-separated turns
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

const SCRT2 = (process.env.SF_SCRT2_URL ?? '').replace(/\/$/, '')
const ORG_ID = (process.env.SF_ORG_ID ?? '').slice(0, 15)
const APP_NAME = process.env.SF_MIAW_APP_NAME ?? 'heroku_demo'
const ES_CONFIG = args.esconfig ?? 'HVAC_Service_Api'
const WAIT_MS = Number(args.wait ?? 45) * 1000
// Pipe-separated so a multi-turn conversation that actually reaches an action
// can be driven from one command — the first turn rarely calls anything.
const UTTERANCES = args.say
  ? args.say.split('|').map((s) => s.trim()).filter(Boolean)
  : ['My furnace stopped working and it is freezing in here']

const t0 = Date.now()
const at = () => `${String(((Date.now() - t0) / 1000).toFixed(2)).padStart(7)}s`

/** Compact one-line view of a payload, with the full JSON underneath if odd. */
function describe(entry, payload) {
  const type = payload.entryType ?? '(no entryType)'
  const role = entry?.sender?.role ?? '?'
  const text = payload.abstractMessage?.staticContent?.text
  return { type, role, text }
}

console.log(`\n${at()}  token for ${ES_CONFIG}`)
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
if (!tokenRes.ok) {
  console.error(`  HTTP ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 400)}`)
  process.exit(1)
}
const { accessToken } = await tokenRes.json()
console.log(`${at()}  token ok`)

const abort = new AbortController()
let sseReady
const sseOpen = new Promise((r) => (sseReady = r))
/** Every distinct entryType seen, with a count, for the summary at the end. */
const types = new Map()
let agentMessages = 0

;(async () => {
  const res = await fetch(`${SCRT2}/eventrouter/v1/sse`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/event-stream', 'X-Org-Id': ORG_ID },
    signal: abort.signal,
  })
  if (!res.ok) {
    console.error(`  sse HTTP ${res.status}`)
    process.exit(1)
  }
  console.log(`${at()}  SSE open`)
  sseReady()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      // Print the SSE event name too — the client ignores it entirely today.
      const eventName = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim()
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) {
        if (frame.trim()) console.log(`${at()}  [non-data frame] ${frame.trim().slice(0, 120)}`)
        continue
      }
      let outer
      try {
        outer = JSON.parse(dataLine.slice(5).trim())
      } catch {
        console.log(`${at()}  [unparseable] ${dataLine.slice(0, 200)}`)
        continue
      }
      const entry = outer.conversationEntry
      if (!entry?.entryPayload) {
        console.log(`${at()}  [event:${eventName}] no conversationEntry: ${JSON.stringify(outer).slice(0, 300)}`)
        continue
      }
      let payload
      try {
        payload = JSON.parse(entry.entryPayload)
      } catch {
        console.log(`${at()}  [event:${eventName}] unparseable entryPayload`)
        continue
      }
      const { type, role, text } = describe(entry, payload)
      types.set(type, (types.get(type) ?? 0) + 1)
      if (type === 'Message' && role !== 'EndUser') agentMessages++
      console.log(`${at()}  event:${eventName}  ${type}  role=${role}${text ? `  "${text}"` : ''}`)
      // Dump EVERY payload whole, including typing indicators and messages. The
      // progress-indicator text is undocumented on this channel, so it could ride
      // inside a typing frame or as an extra field on a Message rather than as an
      // entryType of its own — filtering any of them out is how you miss it.
      console.log(`          payload: ${JSON.stringify(payload)}`)
    }
  }
})().catch((e) => {
  if (e.name !== 'AbortError') console.error('sse error:', e.message)
})

await sseOpen

const convId = crypto.randomUUID()
const convRes = await fetch(`${SCRT2}/iamessage/api/v2/conversation`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId: convId, esDeveloperName: ES_CONFIG }),
})
console.log(`${at()}  conversation POST ${convRes.status}`)

const waitFor = async (count, ms) => {
  const until = Date.now() + ms
  while (agentMessages < count && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  return agentMessages >= count
}

if (!(await waitFor(1, WAIT_MS))) console.error(`${at()}  no greeting within ${WAIT_MS / 1000}s`)
else console.log(`${at()}  <<< greeting landed`)

let expected = agentMessages
for (const text of UTTERANCES) {
  const sent = Date.now()
  console.log(`\n${at()}  >>> sending "${text}"`)
  const res = await fetch(`${SCRT2}/iamessage/api/v2/conversation/${convId}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        id: crypto.randomUUID(),
        messageType: 'StaticContentMessage',
        staticContent: { formatType: 'Text', text },
      },
      esDeveloperName: ES_CONFIG,
      isNewMessagingSession: false,
    }),
  })
  console.log(`${at()}  message POST ${res.status} (${Date.now() - sent}ms to ack)`)
  expected += 1
  if (!(await waitFor(expected, WAIT_MS))) console.error(`${at()}  no reply within ${WAIT_MS / 1000}s`)
  else console.log(`${at()}  <<< reply in ${Date.now() - sent}ms end to end`)
}

await fetch(`${SCRT2}/iamessage/api/v2/conversation/${convId}?esDeveloperName=${ES_CONFIG}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${accessToken}` },
}).catch(() => {})
abort.abort()

console.log('\nentryTypes seen:')
types.forEach((n, type) => console.log(`  ${String(n).padStart(3)}  ${type}`))
console.log()
