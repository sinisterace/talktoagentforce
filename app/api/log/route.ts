import { loggingEnabled, createSession, createTurn } from '@/lib/salesforce-rest'
import { getAgent } from '@/lib/agents'

/**
 * Transcript logging for the demo.
 *
 * One endpoint, two actions, because the browser only ever needs to say "started"
 * or "here's a turn":
 *
 *   { action: 'start', conversationId, agentKey } -> { sessionId }
 *   { action: 'turn',  sessionId, speaker, text, turnNumber, latencyMs }
 *
 * There is no 'end'. A visitor closing the tab is the normal way a demo ends and no
 * request survives it, so an end-of-call write mostly never arrived — and
 * everything it carried is derivable from the turn rows anyway. See
 * lib/salesforce-rest.ts.
 *
 * Every failure returns 200 with { logged: false }. A demo must never break
 * because analytics broke — the visitor's conversation is the product, this is
 * the instrumentation.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = {
  action?: string
  conversationId?: string
  agentKey?: string
  sessionId?: string
  speaker?: string
  text?: string
  turnNumber?: number
  latencyMs?: number
}

export async function POST(req: Request) {
  if (!loggingEnabled()) {
    return Response.json({ logged: false, reason: 'logging-not-configured' })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return Response.json({ logged: false, reason: 'bad-json' }, { status: 400 })
  }

  try {
    switch (body.action) {
      case 'start': {
        const { conversationId, agentKey } = body
        if (!conversationId || !agentKey) {
          return Response.json({ logged: false, reason: 'missing-fields' }, { status: 400 })
        }
        // Reject unknown keys so a crafted request can't fill the object with junk.
        if (!getAgent(agentKey)) {
          return Response.json({ logged: false, reason: 'unknown-agent' }, { status: 400 })
        }
        const sessionId = await createSession({ conversationId, agentTemplate: agentKey })
        return Response.json({ logged: true, sessionId })
      }

      case 'turn': {
        const { sessionId, text, turnNumber } = body
        if (!sessionId || !text || typeof turnNumber !== 'number') {
          return Response.json({ logged: false, reason: 'missing-fields' }, { status: 400 })
        }
        await createTurn({
          sessionId,
          speaker: body.speaker === 'agent' ? 'agent' : 'visitor',
          text,
          turnNumber,
          latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
        })
        return Response.json({ logged: true })
      }

      default:
        return Response.json({ logged: false, reason: 'unknown-action' }, { status: 400 })
    }
  } catch (err) {
    console.error('[log] ', err)
    return Response.json({
      logged: false,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
