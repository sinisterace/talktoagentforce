import { serverEnv } from '@/lib/env'
import { scrub } from '@/lib/scrub'

/**
 * Minimal server-side Salesforce REST client for writing Demo_Session__c and
 * Demo_Turn__c rows.
 *
 * Two writes, both on the way in: one row when a call starts, one per turn. Nothing
 * is written when a call ends — see the note above where endSession used to be.
 *
 * Authenticates with the OAuth client-credentials flow against a connected app,
 * which is the only grant that works without a human at a browser. The token is
 * cached in module scope for the life of the dyno and refreshed a minute before
 * it expires.
 *
 * If SF_CLIENT_ID / SF_CLIENT_SECRET / SF_INSTANCE_URL are not set, every
 * function here is a no-op. Transcript logging is a nice-to-have; a missing
 * connected app must never break a live demo.
 */

const API_VERSION = 'v64.0'

let cached: { token: string; instanceUrl: string; expiresAt: number } | null = null

export function loggingEnabled(): boolean {
  return serverEnv.salesforceLogging !== null
}

async function getToken(): Promise<{ token: string; instanceUrl: string } | null> {
  const cfg = serverEnv.salesforceLogging
  if (!cfg) return null
  if (cached && Date.now() < cached.expiresAt) {
    return { token: cached.token, instanceUrl: cached.instanceUrl }
  }

  const res = await fetch(`${cfg.instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  })
  if (!res.ok) {
    throw new Error(`Salesforce token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { access_token: string; instance_url?: string }
  cached = {
    token: json.access_token,
    instanceUrl: (json.instance_url ?? cfg.instanceUrl).replace(/\/$/, ''),
    // Client-credentials tokens follow the session timeout, typically 2 hours.
    // An hour is a safe cache window that still avoids a token call per turn.
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
  return { token: cached.token, instanceUrl: cached.instanceUrl }
}

/**
 * `retry` is false on the one re-attempt after a 401, so a token that is fresh and
 * still rejected fails instead of recursing.
 *
 * That matters more than it looks: a 401 the new token cannot fix — the connected
 * app's policy changed, the integration user was deactivated, the profile lost the
 * object — is permanent, and retrying it in a loop would spin one token request
 * and one REST call per iteration, on the request path, forever. Logging is
 * fire-and-forget, so nothing upstream would ever surface it; the dyno would just
 * hammer the org until it was rate-limited.
 */
async function rest(path: string, init: { method?: string; body?: unknown } = {}, retry = true) {
  const auth = await getToken()
  if (!auth) return null
  const res = await fetch(`${auth.instanceUrl}/services/data/${API_VERSION}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (res.status === 401 && retry) {
    // Token was revoked or the session timed out early. Drop it and try once more
    // with a fresh one.
    cached = null
    return rest(path, init, false)
  }
  if (!res.ok) {
    throw new Error(`Salesforce ${init.method ?? 'GET'} ${path} → ${res.status} ${(await res.text()).slice(0, 400)}`)
  }
  const raw = await res.text()
  return raw ? JSON.parse(raw) : {}
}

export type SessionStart = {
  conversationId: string
  agentTemplate: string
}

/** Returns the new Demo_Session__c id, or null when logging is disabled. */
export async function createSession(s: SessionStart): Promise<string | null> {
  const res = await rest('/sobjects/Demo_Session__c', {
    method: 'POST',
    body: {
      Conversation_Id__c: s.conversationId,
      Agent_Template__c: s.agentTemplate,
      Started_At__c: new Date().toISOString(),
    },
  })
  return (res as { id?: string } | null)?.id ?? null
}

export type TurnRecord = {
  sessionId: string
  speaker: 'visitor' | 'agent'
  text: string
  turnNumber: number
  latencyMs?: number
}

export async function createTurn(t: TurnRecord): Promise<void> {
  await rest('/sobjects/Demo_Turn__c', {
    method: 'POST',
    body: {
      Demo_Session__c: t.sessionId,
      Speaker__c: t.speaker,
      // Scrubbed here rather than in the route so there is exactly one path to
      // the database and no way to insert raw visitor text by accident.
      // The field is a 32k long text area; anything longer is a runaway reply.
      Transcript__c: scrub(t.text).slice(0, 32768),
      Turn_Number__c: t.turnNumber,
      Spoken_At__c: new Date().toISOString(),
      ...(t.latencyMs === undefined ? {} : { Latency_Ms__c: t.latencyMs }),
    },
  })
}

/*
 * There is no endSession. Nothing is written when a call finishes.
 *
 * It used to stamp Ended_At__c, Turn_Count__c and Reached_Outcome__c, and all
 * three were removed along with the request that set them. Every one was either
 * derivable or a lie. The turn count is `SELECT COUNT(Id) FROM Demo_Turn__c`, and
 * the end time is the last turn's Spoken_At__c — both exact, and neither depending
 * on the browser still being alive to report them. Reached_Outcome__c was always
 * written as literal `false` because nothing ever computed it.
 *
 * That last point is the real argument. A visitor closing the tab is the normal
 * way a demo ends, and no request survives it, so the end-of-call write mostly did
 * not happen. A field that is null on most rows is worse than no field: it reads as
 * "this call did not end" rather than "nobody was there to tell us".
 */
