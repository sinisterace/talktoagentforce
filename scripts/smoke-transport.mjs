#!/usr/bin/env node
/**
 * End-to-end smoke test of the anonymous transport, without a browser.
 *
 * Reproduces exactly what lib/agentforce-client.ts does — guest token,
 * conversation, SSE stream, message — and prints the agent's replies. Run it
 * after any change to the channel stack or the client, and after any Heroku
 * config change, to confirm an anonymous visitor can still hold a conversation.
 *
 * Usage:
 *   node scripts/smoke-transport.mjs                       # against the HVAC agent
 *   node scripts/smoke-transport.mjs --esconfig Retail_Api
 *   node scripts/smoke-transport.mjs --say "my furnace is dead"
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

// Read .env directly: this script runs outside Next, which is what loads it.
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
const UTTERANCES = args.say
  ? [args.say]
  : ['My furnace stopped working and it is freezing in here', 'No, nothing like that. Everything smells normal.']

if (!SCRT2 || !ORG_ID) {
  console.error('SF_SCRT2_URL and SF_ORG_ID must be set (in .env or the environment).')
  process.exit(1)
}

const t0 = Date.now()
const at = () => `${String((Date.now() - t0) / 1000).padStart(6)}s`

// ------------------------------------------------------------- 1. guest token

console.log(`\n${at()}  requesting guest token for ${ES_CONFIG}...`)
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
  console.error(`  ✗ HTTP ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 400)}`)
  process.exit(1)
}
const { accessToken, context } = await tokenRes.json()
const authMode = context?.configuration?.embeddedServiceConfig?.embeddedServiceMessagingChannel?.authMode
console.log(`  ✓ token ${accessToken.length} chars, authMode ${authMode}`)
if (authMode !== 'UnAuth') {
  console.error('  ✗ authMode is not UnAuth — anonymous visitors will be rejected.')
  process.exit(1)
}

// -------------------------------------------------------------------- 2. SSE

const replies = []
let sseReady
const sseOpen = new Promise((res) => { sseReady = res })
const abort = new AbortController()

;(async () => {
  const res = await fetch(`${SCRT2}/eventrouter/v1/sse`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/event-stream', 'X-Org-Id': ORG_ID },
    signal: abort.signal,
  })
  if (!res.ok) { console.error(`  ✗ sse HTTP ${res.status}`); process.exit(1) }
  console.log(`${at()}  ✓ SSE stream open`)
  sseReady()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const seen = new Set()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let entry, payload
      try {
        entry = JSON.parse(line.slice(5).trim()).conversationEntry
        payload = JSON.parse(entry.entryPayload)
      } catch { continue }
      if (payload.entryType !== 'Message') continue
      if (seen.has(entry.identifier)) continue
      seen.add(entry.identifier)
      const text = payload.abstractMessage?.staticContent?.text
      if (!text) continue
      const who = entry.sender?.role === 'EndUser' ? 'visitor' : 'AGENT  '
      console.log(`${at()}  ${who} >> ${text}`)
      if (entry.sender?.role !== 'EndUser') replies.push(text)
    }
  }
})().catch((e) => { if (e.name !== 'AbortError') console.error('sse error:', e.message) })

await sseOpen

// ----------------------------------------------------------- 3. conversation

const convId = crypto.randomUUID()
const convRes = await fetch(`${SCRT2}/iamessage/api/v2/conversation`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId: convId, esDeveloperName: ES_CONFIG }),
})
console.log(`${at()}  ${convRes.ok ? '✓' : '✗'} conversation ${convRes.status} (${convId})`)
if (!convRes.ok) { console.error((await convRes.text()).slice(0, 400)); process.exit(1) }

// ------------------------------------------------------------- 4. turn-taking

const waitForReply = async (count, ms = 45000) => {
  const until = Date.now() + ms
  while (replies.length < count && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  return replies.length >= count
}

// The agent greets on its own once routing completes; wait for that before speaking.
if (!(await waitForReply(1))) {
  console.error(`${at()}  ✗ no greeting within 45s — check the routing flow and queue.`)
  abort.abort()
  process.exit(1)
}

let expected = 1
for (const text of UTTERANCES) {
  const sent = Date.now()
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
  if (res.status !== 202) {
    console.error(`${at()}  ✗ message returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
    break
  }
  expected += 1
  if (!(await waitForReply(expected))) {
    console.error(`${at()}  ✗ no reply within 45s`)
    break
  }
  console.log(`${at()}  (round trip ${Date.now() - sent}ms)`)
}

// ----------------------------------------------------------------- 5. hang up

await fetch(`${SCRT2}/iamessage/api/v2/conversation/${convId}?esDeveloperName=${ES_CONFIG}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${accessToken}` },
}).catch(() => {})
abort.abort()

console.log(`\n${at()}  ${replies.length} agent replies. conversationId ${convId}\n`)
process.exit(replies.length > 1 ? 0 : 1)
