/**
 * The industry template library.
 *
 * Adding an agent is four steps:
 *   1. node scripts/provision-industry.mjs --key <key> --agent <BotDeveloperName>
 *   2. add the entry it prints to AGENTS below, including `greeting`
 *   3. node scripts/render-greetings.mjs      (pre-renders the greeting audio)
 *   4. drop <key>.png in assets/industry-icons/, then npm run icons
 *
 * `esConfigName` is the EmbeddedServiceConfig DeveloperName. The browser passes
 * it to the scrt2 endpoints; it is the only per-agent value the transport needs.
 */

export type AgentTemplate = {
  /** URL-safe key, also the route segment. */
  key: string
  /** What the visitor sees. Deliberately no company or persona name. */
  label: string
  /** One line describing what the visitor can try. */
  blurb: string
  /** EmbeddedServiceConfig DeveloperName, deploymentType API. */
  esConfigName: string
  /**
   * Verbatim copy of `system.messages.welcome` from the agent's .agent file.
   *
   * The greeting is the same sentence for every visitor forever, but Agentforce
   * takes up to 30 seconds to push it on a cold planner. So it is rendered to a
   * static MP3 ahead of time (`scripts/render-greetings.mjs`) and played the
   * moment the visitor taps, and the copy that eventually arrives over SSE is
   * suppressed by matching against this string. Keep the two in sync — if they
   * drift, the visitor hears the greeting twice.
   */
  greeting: string
  /**
   * Accent colour for this industry's tile rim and icon glow, so a grid of ten
   * templates reads as ten things rather than ten copies of one thing. Pick it
   * out of the icon art itself — it is the colour the eye already sees there.
   */
  accent: string
  /**
   * Two or three things worth saying, shown on the pre-call screen.
   *
   * The demo's real failure mode is not latency, it is the visitor tapping and
   * then going quiet because they do not know what this agent can do. "Tap and
   * talk" assumes they have a problem in mind; they are usually standing in a
   * booth being shown something. Phrase them as the visitor would say them out
   * loud, not as menu items — the point is that they can be read verbatim.
   */
  starters: string[]
  /** False while an agent is being built — hidden from the public list. */
  live: boolean
}

export const AGENTS: AgentTemplate[] = [
  {
    key: 'hvac',
    label: 'HVAC Service Agent',
    blurb: 'Book an emergency repair, reschedule a visit, or ask about service plans.',
    esConfigName: 'HVAC_Service_Api',
    greeting: 'Thanks for calling. This is the HVAC service agent. How can I help you today?',
    accent: '#38bdf8',
    // One per specialist topic, chosen because each reaches a different Apex
    // action — emergency_dispatch, appointment_scheduling, service_plans. A
    // starter that only produces talk makes the agent look like a chatbot.
    starters: [
      'My furnace stopped working and the house is freezing',
      'I need to book a tune-up for next week',
      'What service plans do you offer?',
    ],
    live: true,
  },
  // Art and copy are ready for these two; the agents themselves are not. They
  // render as dimmed, unclickable tiles rather than as a sentence promising
  // industries that never appear — a greyed tile with real art reads as a
  // roadmap, a paragraph reads as marketing.
  {
    key: 'retail',
    label: 'Retail Agent',
    blurb: 'Track an order, start a return, or check what is in stock nearby.',
    esConfigName: '',
    greeting: '',
    accent: '#2dd4bf',
    starters: [],
    live: false,
  },
  {
    key: 'financial-services',
    label: 'Financial Services Agent',
    blurb: 'Check a balance, dispute a charge, or ask about a loan application.',
    esConfigName: 'Financial_Services_Api',
    greeting:
      "Thanks for calling. This is the financial services agent, and for this demo you're signed in as an existing customer, so I can look things up right away. How can I help?",
    accent: '#f472b6',
    // One per specialist reach — a read (account_overview), a write to Case
    // (dispute_charge / fraud_response), and a knowledge answer (banking_questions
    // via loan_status). Each fires a different action so the tile is not all talk.
    starters: [
      "What's my checking balance?",
      "Where's my mortgage application at?",
      "There's a charge I don't recognise",
      'I think I lost my card',
    ],
    live: true,
  },
]

export const LIVE_AGENTS = AGENTS.filter((a) => a.live)

/** Templates whose art exists but whose agent is not deployed yet. */
export const SOON_AGENTS = AGENTS.filter((a) => !a.live)

export function getAgent(key: string): AgentTemplate | undefined {
  return AGENTS.find((a) => a.key === key)
}
