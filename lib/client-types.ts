/**
 * Shapes the browser consumes. Kept apart from lib/agents.ts because that file
 * is also imported by build scripts under plain Node, and apart from the API
 * route handlers because those import server-only env.
 */

/** One entry in `/api/config`'s `agents` array. */
export type PublicAgent = {
  key: string
  label: string
  blurb: string
  esConfigName: string
  /** Verbatim `system.messages.welcome`; the live SSE copy is suppressed by it. */
  greeting: string
  /** Pre-rendered greeting MP3, played the instant the visitor taps. */
  greetingAudio: string
  /** Industry art, written by scripts/render-icons.mjs. */
  icon: { tile: string; chip: string }
  /** Per-industry accent, applied as a CSS custom property. */
  accent: string
  /** Things worth saying, shown before the call starts. */
  starters: string[]
}

/** A template with art but no deployed agent — shown dimmed and unclickable. */
export type SoonAgent = {
  key: string
  label: string
  blurb: string
  accent: string
  icon: { tile: string; chip: string }
}

export type PublicConfig = {
  scrt2Url: string
  orgId: string
  appName: string
  agents: PublicAgent[]
  soon: SoonAgent[]
}

/* ------------------------------------------------------- blueprint (screen 4) */

/** Written by scripts/extract-blueprint.mjs to public/blueprint/<key>.json. */
export type Blueprint = {
  key: string
  label: string
  developerName: string | null
  agentLabel: string | null
  agentType: string | null
  description: string | null
  systemInstructions: string | null
  welcome: string | null
  voice: {
    voiceId: string | null
    speed: number | null
    stability: number | null
    similarity: number | null
  } | null
  knowledge: {
    ragFeatureConfigId: string | null
    citationsEnabled: boolean
    documents: string[]
  } | null
  topics: BlueprintTopic[]
  actions: BlueprintAction[]
  variables: BlueprintVariable[]
  stats: {
    topics: number
    actions: number
    apexActions: number
    variables: number
    agentScriptLines: number
  }
}

export type InstructionBlock = {
  /** An `@variables.…` expression when the block is conditional, else null. */
  condition: string | null
  lines: string[]
}

export type Guard = {
  condition: string | null
  then: string[]
}

export type BlueprintTopic = {
  name: string
  label: string
  description: string
  isRouter: boolean
  instructions: InstructionBlock[]
  beforeReasoning: Guard[]
  afterReasoning: Guard[]
  transitions: { name: string; to: string; when: string }[]
  setters: { name: string; description: string; variables: string[] }[]
  calls: { name: string; action: string; description: string; availableWhen: string | null }[]
}

export type BlueprintParam = {
  name: string
  type: string
  description: string
  required: boolean
}

export type BlueprintAction = {
  name: string
  label: string
  description: string
  target: string
  kind: 'Apex' | 'Standard' | 'Other'
  apexClass: string | null
  progressMessage: string
  requiresConfirmation: boolean
  /** Topic that owns this action. */
  owner: string
  inputs: BlueprintParam[]
  outputs: BlueprintParam[]
}

export type BlueprintVariable = {
  name: string
  kind: string
  linkedTo: string | null
  description: string
}
