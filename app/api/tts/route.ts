import { serverEnv } from '@/lib/env'
import { checkTtsBudget, clientIp, sameOrigin } from '@/lib/rate-limit'

/**
 * ElevenLabs text-to-speech proxy.
 *
 * Exists for one reason: the API key must never reach the browser. The visitor
 * posts text, we post it on with the key attached, and stream the MP3 straight
 * back. Nothing is stored.
 *
 * Uses the streaming endpoint so audio starts playing before the whole clip is
 * generated — on a long agent reply that is the difference between a natural
 * pause and an awkward one.
 *
 * This is the one route in the app that costs money per call, so it is also the
 * one that is metered: an Origin check to stop the endpoint being embedded
 * elsewhere as a free TTS backend, and per-IP plus global character budgets to
 * bound the bill. See lib/rate-limit.ts for the numbers and why.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Beyond this, a "reply" is not a reply. Caps spend if the URL is found and abused. */
const MAX_CHARS = 1200

export async function POST(req: Request) {
  // Cheapest check first: refuse a cross-site embed before reading the body.
  if (!sameOrigin(req)) {
    return Response.json({ error: 'This endpoint only serves the demo itself.' }, { status: 403 })
  }

  let text: string
  try {
    const body = (await req.json()) as { text?: unknown }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return Response.json({ error: 'Provide a non-empty "text" string.' }, { status: 400 })
    }
    text = body.text.trim()
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  if (text.length > MAX_CHARS) {
    return Response.json({ error: `Text exceeds ${MAX_CHARS} characters.` }, { status: 413 })
  }

  // Charged before the upstream call, since the cost is incurred the moment
  // ElevenLabs accepts the request.
  const budget = checkTtsBudget(clientIp(req), text.length)
  if (!budget.ok) {
    console.warn(`[tts] refused: ${budget.scope} ${budget.limit} budget exhausted`)
    return Response.json(
      {
        error:
          budget.scope === 'global'
            ? 'The demo is busy right now. The reply is still in the transcript.'
            : 'Too many voice replies from this connection. The reply is still in the transcript.',
        retryAfter: budget.retryAfterSeconds,
      },
      { status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
    )
  }

  const voiceId = serverEnv.elevenLabsVoiceId
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': serverEnv.elevenLabsKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: serverEnv.elevenLabsModelId,
        // Matches the modality voice: block in the .agent file, so the browser
        // demo and a real NativeVoice deployment sound like the same agent.
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.75,
          speed: 1,
        },
      }),
    })
  } catch (err) {
    return Response.json(
      { error: `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    )
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    // Surface the status so the client can fall back to text-only rather than
    // looking broken. 401 means the key was rotated and Heroku wasn't updated.
    return Response.json(
      { error: `ElevenLabs returned ${upstream.status}`, detail: detail.slice(0, 300) },
      { status: 502 },
    )
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  })
}
