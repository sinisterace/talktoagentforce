/**
 * In-memory rate limiting for the paid endpoint.
 *
 * /api/tts is the only route in this app that spends real money: every request
 * bills ElevenLabs per character. The URL is discoverable by anyone who opens
 * devtools on the public demo, so it needs a cap that does not depend on the
 * caller being the demo's own UI.
 *
 * Deliberately in-process, with no Redis and no add-on:
 *   - The demo runs on a single web dyno. One process means one counter, and the
 *     counter is exactly as accurate as it needs to be.
 *   - A dyno restart (deploy, or Heroku's daily cycle) forgets the buckets. The
 *     worst case is one extra window's worth of spend, which is bounded and
 *     small; the alternative is an add-on and a network hop per reply.
 * If this ever runs on more than one dyno, the per-IP caps become per-IP-per-dyno
 * and want moving to a shared store.
 *
 * Two independent limits, because they fail differently:
 *   - per IP, so one visitor cannot burn the budget;
 *   - global, so a thousand IPs cannot either. The global cap is a wallet
 *     backstop, set high enough that real concurrent demo traffic never sees it.
 */

/** A continuously-refilling token bucket. Tokens are characters or requests. */
type Bucket = {
  /** Tokens available at `last`. */
  tokens: number
  /** Epoch ms of the most recent refill calculation. */
  last: number
}

export type Limit = {
  /** Bucket capacity, which is also the maximum burst. */
  capacity: number
  /** Time in ms for an empty bucket to refill completely. */
  refillMs: number
}

export type LimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; scope: 'ip' | 'global'; limit: 'requests' | 'characters' }

/**
 * Per IP, per hour. A real conversation costs about 2,500 characters — the
 * greeting is pre-rendered and served as a static file, so it costs nothing —
 * which leaves room for roughly eight full conversations an hour from one
 * address before anything is refused.
 */
const IP_CHARS: Limit = { capacity: 20_000, refillMs: 60 * 60 * 1000 }

/** Cheap requests still cost a round trip and an ElevenLabs connection. */
const IP_REQUESTS: Limit = { capacity: 120, refillMs: 60 * 60 * 1000 }

/**
 * Everyone combined, per hour. Ten simultaneous prospects mid-demo use about
 * 25k; this sits well above that and well below a bill worth noticing.
 */
const GLOBAL_CHARS: Limit = { capacity: 250_000, refillMs: 60 * 60 * 1000 }

/** Stop the map growing without bound when the demo is shared widely. */
const MAX_TRACKED_IPS = 5_000

const ipChars = new Map<string, Bucket>()
const ipRequests = new Map<string, Bucket>()
const globalChars: Bucket = { tokens: GLOBAL_CHARS.capacity, last: 0 }

/** Tokens in the bucket right now, without mutating it. */
function available(bucket: Bucket, limit: Limit, now: number): number {
  const elapsed = now - bucket.last
  if (elapsed <= 0) return bucket.tokens
  const refilled = bucket.tokens + (elapsed / limit.refillMs) * limit.capacity
  return Math.min(limit.capacity, refilled)
}

/** Seconds until `cost` tokens would be available. Always at least 1. */
function waitSeconds(shortfall: number, limit: Limit): number {
  const ms = (shortfall / limit.capacity) * limit.refillMs
  return Math.max(1, Math.ceil(ms / 1000))
}

function bucketFor(map: Map<string, Bucket>, key: string, limit: Limit, now: number): Bucket {
  let b = map.get(key)
  if (!b) {
    // Evict the least-recently-touched entries rather than the whole map: a
    // wholesale clear would hand every tracked abuser a full bucket back.
    // `forEach` rather than spreading `map.entries()`, which this project's es5
    // compile target rejects.
    if (map.size >= MAX_TRACKED_IPS) {
      const stale: Array<{ key: string; last: number }> = []
      map.forEach((v, k) => stale.push({ key: k, last: v.last }))
      stale.sort((a, z) => a.last - z.last)
      for (let i = 0; i < Math.ceil(MAX_TRACKED_IPS / 4); i++) map.delete(stale[i].key)
    }
    b = { tokens: limit.capacity, last: now }
    map.set(key, b)
  }
  return b
}

/**
 * Charges `chars` characters and one request against the caller's budgets.
 * All-or-nothing: if any limit would be exceeded nothing is debited, so a
 * refused request does not push the caller further into the red.
 */
export function checkTtsBudget(ip: string, chars: number, now = Date.now()): LimitDecision {
  if (globalChars.last === 0) globalChars.last = now

  const reqBucket = bucketFor(ipRequests, ip, IP_REQUESTS, now)
  const charBucket = bucketFor(ipChars, ip, IP_CHARS, now)

  const reqLeft = available(reqBucket, IP_REQUESTS, now)
  const charLeft = available(charBucket, IP_CHARS, now)
  const globalLeft = available(globalChars, GLOBAL_CHARS, now)

  if (reqLeft < 1) {
    return {
      ok: false,
      scope: 'ip',
      limit: 'requests',
      retryAfterSeconds: waitSeconds(1 - reqLeft, IP_REQUESTS),
    }
  }
  if (charLeft < chars) {
    return {
      ok: false,
      scope: 'ip',
      limit: 'characters',
      retryAfterSeconds: waitSeconds(chars - charLeft, IP_CHARS),
    }
  }
  if (globalLeft < chars) {
    return {
      ok: false,
      scope: 'global',
      limit: 'characters',
      retryAfterSeconds: waitSeconds(chars - globalLeft, GLOBAL_CHARS),
    }
  }

  reqBucket.tokens = reqLeft - 1
  reqBucket.last = now
  charBucket.tokens = charLeft - chars
  charBucket.last = now
  globalChars.tokens = globalLeft - chars
  globalChars.last = now
  return { ok: true }
}

/**
 * The caller's address, as observed by the Heroku router.
 *
 * The LAST entry in X-Forwarded-For, not the first. Heroku appends the socket
 * address it actually saw to whatever the client sent, so the first entry is
 * attacker-controlled — keying the limiter on it would let one client rotate
 * through a fresh full bucket on every request by varying the header.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

/**
 * True when the request came from this app's own pages.
 *
 * Not a security boundary — Origin is trivially forged outside a browser, and
 * the per-IP budget above is what actually bounds the spend. What it does stop
 * is the cheap and likely abuse: someone embedding our /api/tts in their own
 * page as a free TTS backend, which a browser cannot do once Origin is checked.
 *
 * A missing Origin is allowed, because that is what `curl` and uptime checks
 * look like, and because Safari has historically omitted it on same-origin
 * requests. Those callers still face the IP budget.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true

  const extra = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  if (extra.includes(origin.replace(/\/$/, ''))) return true

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }

  // x-forwarded-host first: behind the Heroku router, `host` is the app's own
  // hostname, which is what the browser sent, but a proxy in front of it (a
  // custom domain) rewrites one and not always the other.
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  return !!host && originHost === host
}
