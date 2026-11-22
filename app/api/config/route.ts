import { publicConfig } from '@/lib/env'
import { LIVE_AGENTS, SOON_AGENTS } from '@/lib/agents'

/**
 * Everything the browser needs to open a conversation: the scrt2 host, the org
 * id, the MIAW app name, and the list of live industry templates.
 *
 * None of it is secret. Guest tokens minted from these values can only reach the
 * messaging endpoints as an anonymous visitor. Serving it from an endpoint rather
 * than baking it into the bundle means a `heroku config:set` takes effect on the
 * next request instead of the next build.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Paths written by scripts/render-icons.mjs; see that file for the sizes. */
function iconsFor(key: string) {
  return { tile: `/icons/${key}-tile.png`, chip: `/icons/${key}-chip.png` }
}

export async function GET() {
  try {
    return Response.json({
      ...publicConfig(),
      agents: LIVE_AGENTS.map(({ key, label, blurb, esConfigName, greeting, accent, starters }) => ({
        key,
        label,
        blurb,
        esConfigName,
        starters,
        // Play `greetingAudio` the instant the visitor taps; Agentforce can take
        // up to 30 seconds to push its own copy on a cold planner. Pass
        // `greeting` to AgentforceConversation as `suppressGreeting` so the late
        // copy is dropped instead of spoken twice.
        greeting,
        greetingAudio: `/greetings/${key}.mp3`,
        accent,
        icon: iconsFor(key),
      })),
      soon: SOON_AGENTS.map(({ key, label, blurb, accent }) => ({
        key,
        label,
        blurb,
        accent,
        icon: iconsFor(key),
      })),
    })
  } catch (err) {
    // A missing env var here means the release is misconfigured. Say so plainly.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
