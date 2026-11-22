#!/usr/bin/env node
/**
 * Unit test for lib/rate-limit.ts.
 *
 * Worth testing because the failure modes are silent in both directions: too
 * strict and the demo goes mute mid-conversation for a real prospect, too loose
 * and the endpoint is a free TTS backend on someone else's bill. The clock is
 * injected so refill behaviour is checked without waiting an hour.
 *
 * Usage: node scripts/test-rate-limit.mjs
 */

import { checkTtsBudget, clientIp, sameOrigin } from '../lib/rate-limit.ts'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Distinct key per test, since the buckets are module-level and persist. */
let n = 0
const ip = () => `10.0.0.${++n}`

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

// --------------------------------------------- 1. a normal conversation passes

{
  const me = ip()
  let ok = true
  // Eight replies of ~300 chars, which is a full conversation.
  for (let i = 0; i < 8; i++) {
    if (!checkTtsBudget(me, 300, T0).ok) ok = false
  }
  check('a full conversation is never refused', ok)
}

// ------------------------------------------------ 2. the per-IP character cap

{
  const me = ip()
  const first = checkTtsBudget(me, 19_000, T0)
  const second = checkTtsBudget(me, 5_000, T0)
  check('under the per-IP character cap passes', first.ok)
  check('over the per-IP character cap is refused', !second.ok)
  check(
    'refusal says which budget and how long',
    !second.ok && second.scope === 'ip' && second.limit === 'characters' && second.retryAfterSeconds > 0,
    JSON.stringify(second),
  )
}

// ------------------------------------------------- 3. a refusal debits nothing

{
  const me = ip()
  checkTtsBudget(me, 19_500, T0)
  // This is refused; if it debited anyway, the small request after it would be
  // refused too and the caller could never recover inside the window.
  check('an over-cap request is refused', !checkTtsBudget(me, 5_000, T0).ok)
  check('...and did not consume the remainder', checkTtsBudget(me, 400, T0).ok)
}

// -------------------------------------------------------- 4. buckets refill

{
  const me = ip()
  check('spend the whole per-IP budget', checkTtsBudget(me, 20_000, T0).ok)
  check('immediately after, refused', !checkTtsBudget(me, 1_000, T0).ok)
  check('a tenth of the window back later, allowed', checkTtsBudget(me, 1_000, T0 + HOUR / 10).ok)
  check('a full window later, fully refilled', checkTtsBudget(me, 19_000, T0 + 2 * HOUR).ok)
}

// ------------------------------------------------------ 5. the request cap

{
  const me = ip()
  let refusedAt = -1
  for (let i = 0; i < 140; i++) {
    // One character each, so only the request count can be the thing that trips.
    if (!checkTtsBudget(me, 1, T0).ok) {
      refusedAt = i
      break
    }
  }
  check('the request cap trips at 120', refusedAt === 120, `tripped at ${refusedAt}`)
}

// ---------------------------------------------- 6. one IP cannot starve another

{
  const a = ip()
  const b = ip()
  checkTtsBudget(a, 20_000, T0)
  check('a different IP is unaffected', checkTtsBudget(b, 2_000, T0).ok)
}

// --------------------------------------------------------- 7. the global cap
// Runs last: it deliberately drains the shared bucket, so anything after it
// would see a global refusal rather than whatever it meant to test.

{
  let refusal = null
  // Fresh IPs each round, so the per-IP caps cannot be what trips.
  for (let i = 0; i < 40; i++) {
    const r = checkTtsBudget(ip(), 19_000, T0)
    if (!r.ok) {
      refusal = r
      break
    }
  }
  check('many IPs eventually hit the global cap', refusal !== null)
  check('the global refusal is labelled global', refusal?.scope === 'global', JSON.stringify(refusal))
}

// --------------------------------------------------------------- clientIp

{
  const withXff = (v) => clientIp(new Request('https://x.test/', { headers: { 'x-forwarded-for': v } }))
  check('single X-Forwarded-For is used', withXff('203.0.113.9') === '203.0.113.9')
  // The last entry is the one Heroku's router appended; the earlier ones are
  // whatever the client claimed. Keying on the first would let one client mint
  // a fresh bucket per request.
  check(
    'a spoofed X-Forwarded-For prefix is ignored',
    withXff('1.1.1.1, 2.2.2.2, 203.0.113.9') === '203.0.113.9',
  )
  check('no headers falls back to a constant', clientIp(new Request('https://x.test/')) === 'unknown')
}

// -------------------------------------------------------------- sameOrigin

{
  const req = (headers) => new Request('https://x.test/', { headers })
  check(
    'matching Origin and Host pass',
    sameOrigin(req({ origin: 'https://demo.example', host: 'demo.example' })),
  )
  check(
    'a foreign Origin is refused',
    !sameOrigin(req({ origin: 'https://evil.example', host: 'demo.example' })),
  )
  check('a missing Origin passes (curl, uptime checks)', sameOrigin(req({ host: 'demo.example' })))
  check(
    'X-Forwarded-Host is preferred over Host',
    sameOrigin(req({
      origin: 'https://demo.example',
      host: 'internal.herokuapp.com',
      'x-forwarded-host': 'demo.example',
    })),
  )
  check('a malformed Origin is refused', !sameOrigin(req({ origin: 'not a url', host: 'demo.example' })))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
