#!/usr/bin/env node
/**
 * Unit test for lib/agentforce-client.ts against a mocked transport.
 *
 * The two behaviours here are the ones that cannot be tested against the live
 * org, because they only appear when the network misbehaves:
 *
 *   1. A stream that ends normally must be re-opened without consuming the retry
 *      budget. The bug this guards against left the agent mute with no error
 *      after the third reconnect — indistinguishable from a broken agent.
 *   2. The pre-rendered greeting's live twin must be dropped exactly once.
 *
 * Usage: node scripts/test-client.mjs
 */

import { AgentforceConversation } from '../lib/agentforce-client.ts'

const GREETING = 'Thanks for calling. This is the HVAC service agent. How can I help you today?'

/** One SSE frame carrying an agent message. */
function messageFrame(text, id) {
  const entryPayload = JSON.stringify({
    entryType: 'Message',
    abstractMessage: { staticContent: { text } },
  })
  const body = JSON.stringify({
    conversationEntry: { identifier: id, entryPayload, sender: { role: 'Chatbot' } },
  })
  return `event: CONVERSATION_MESSAGE\ndata: ${body}\n\n`
}

/**
 * Installs a fake fetch. `streams` is one entry per SSE connection attempt:
 * an array of strings to emit then close, or the string 'fail' to reject.
 */
function mockFetch(streams) {
  let attempt = 0
  const attempts = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('access-token')) {
      return new Response(JSON.stringify({ accessToken: 'fake' }), { status: 200 })
    }
    if (u.includes('/eventrouter/v1/sse')) {
      const plan = streams[attempt] ?? []
      attempts.push(plan)
      attempt++
      if (plan === 'fail') return new Response('nope', { status: 503 })
      return new Response(
        new ReadableStream({
          start(c) {
            for (const f of plan) c.enqueue(new TextEncoder().encode(f))
            c.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    // conversation create, message send, delete
    init?.signal?.throwIfAborted?.()
    return new Response('', { status: 202 })
  }
  return { attempts: () => attempts.length }
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------- 1. greeting suppression

{
  mockFetch([[messageFrame(GREETING, 'e1'), messageFrame('What is the address?', 'e2')]])
  const said = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    suppressGreeting: GREETING,
    onAgentMessage: (t) => said.push(t),
  })
  await conv.start()
  await settle()
  await conv.end()
  check('greeting suppressed, following message kept', said.length === 1 && said[0] === 'What is the address?', JSON.stringify(said))
}

// ------------------------------------ 2. greeting NOT suppressed a second time

{
  mockFetch([[messageFrame(GREETING, 'e1'), messageFrame(GREETING, 'e2')]])
  const said = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    suppressGreeting: GREETING,
    onAgentMessage: (t) => said.push(t),
  })
  await conv.start()
  await settle()
  await conv.end()
  check('only the first copy of the greeting is dropped', said.length === 1, JSON.stringify(said))
}

// --------------------------------- 3. no suppressGreeting -> nothing swallowed

{
  mockFetch([[messageFrame(GREETING, 'e1')]])
  const said = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    onAgentMessage: (t) => said.push(t),
  })
  await conv.start()
  await settle()
  await conv.end()
  check('without suppressGreeting the greeting is delivered', said.length === 1 && said[0] === GREETING, JSON.stringify(said))
}

// ------------- 4. THE REGRESSION: many healthy stream renewals stay connected

{
  // Ten consecutive streams that each deliver a message then close normally.
  // Under the old counter this went mute after the third with no error at all.
  const streams = Array.from({ length: 10 }, (_, i) => [messageFrame(`reply ${i}`, `e${i}`)])
  const m = mockFetch(streams)
  const said = []
  const statuses = []
  // Statuses seen up to the moment the last planned message lands. Past that the
  // mock has no streams left and returns an empty one, which the client rightly
  // treats as a failed attempt — that is test 5's job, not this one's.
  let duringHealthy = null
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    onAgentMessage: (t) => {
      said.push(t)
      if (said.length === 10) duringHealthy = [...statuses]
    },
    onStatus: (s) => statuses.push(s),
  })
  await conv.start()
  await settle(300)
  await conv.end()
  check('10 healthy stream renewals all deliver', said.length === 10, `got ${said.length}: ${JSON.stringify(said.slice(0, 3))}`)
  check('no error status during healthy renewals', !(duringHealthy ?? statuses).includes('error'), JSON.stringify(duringHealthy))
  check(
    'reconnect never announced for a healthy stream',
    !(duringHealthy ?? statuses).includes('reconnecting'),
    JSON.stringify(duringHealthy),
  )
  check('stream re-opened each time', m.attempts() >= 10, `attempts ${m.attempts()}`)
}

// ------------------- 5. repeated hard failures surface an error, do not hang

{
  mockFetch(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'])
  const statuses = []
  const details = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    onAgentMessage: () => {},
    onStatus: (s, d) => {
      statuses.push(s)
      if (d) details.push(d)
    },
  })
  await conv.start()
  // Backoff is 0.5 + 1 + 2 + 4 + 8 = 15.5s worst case for five retries.
  await settle(17000)
  check('reconnecting is announced', statuses.includes('reconnecting'), JSON.stringify(statuses))
  check('gives up with an error status', statuses.includes('error'), JSON.stringify(statuses))
  check('error explains what happened', details.some((d) => /reconnect/i.test(d)), JSON.stringify(details))
  await conv.end()
}

// ------------------------ 6. a failure followed by success resets the budget

{
  mockFetch(['fail', 'fail', [messageFrame('recovered', 'e1')], [messageFrame('still here', 'e2')]])
  const said = []
  const statuses = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    onAgentMessage: (t) => said.push(t),
    onStatus: (s) => statuses.push(s),
  })
  await conv.start()
  await settle(3000)
  await conv.end()
  check('recovers after transient failures', said.includes('recovered') && said.includes('still here'), JSON.stringify(said))
  check('no error after recovery', !statuses.includes('error'), JSON.stringify(statuses))
  check('ready re-announced after reconnecting', statuses.indexOf('ready') < statuses.lastIndexOf('ready'), JSON.stringify(statuses))
}

// -------------------------------- 7. hanging up stops the reconnect loop dead

{
  mockFetch(['fail', 'fail', 'fail', 'fail', 'fail', 'fail'])
  const statuses = []
  const conv = new AgentforceConversation({
    scrt2Url: 'https://mock',
    orgId: '00D000000000000',
    esConfigName: 'HVAC_Service_Api',
    appName: 'heroku_demo',
    onAgentMessage: () => {},
    onStatus: (s) => statuses.push(s),
  })
  await conv.start()
  await settle(200)
  await conv.end()
  const afterEnd = statuses.length
  await settle(4000)
  check('no reconnect activity after end()', statuses.length === afterEnd, JSON.stringify(statuses.slice(afterEnd)))
  check('end() does not report an error', !statuses.includes('error'), JSON.stringify(statuses))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
