#!/usr/bin/env node
/**
 * Turns each template's `.agent` file into `public/blueprint/<key>.json` — the
 * data behind the "Look inside" panel that shows a prospect the real agent
 * configuration.
 *
 * Why build time and not runtime: the org has no queryable planner-trace object
 * (`AiAgentSession`, `GenAiPlannerFunctionInvocation` and friends do not exist
 * there), and the objects that do exist — `GenAiPlannerDefinition`,
 * `GenAiPluginDefinition` — return names without instructions, action shapes or
 * the routing graph. The `.agent` file has all of it, it is the artifact a
 * builder actually edits, and reading it here costs the visitor nothing and
 * cannot fail mid-demo.
 *
 * Redaction happens here, once: `default_agent_user` is an org username and is
 * dropped. Everything else in a `.agent` file is the thing being demonstrated.
 *
 *   node scripts/extract-blueprint.mjs           # write every live template
 *   node scripts/extract-blueprint.mjs --check    # verify only, non-zero if stale
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLES = join(ROOT, 'salesforce/force-app/main/default/aiAuthoringBundles')
const KNOWLEDGE = join(ROOT, 'knowledge')
const OUT_DIR = join(ROOT, 'public/blueprint')
const CHECK = process.argv.includes('--check')

/* ---------------------------------------------------------------- parsing --- */

/**
 * `.agent` files are indentation-scoped, so parse to a tree first and read
 * meaning off the tree. Trying to regex the whole file gets the shallow fields
 * right and the nested ones subtly wrong.
 */
function parseTree(source) {
  const root = { text: '', indent: -1, children: [] }
  const stack = [root]
  for (const raw of source.split('\n')) {
    if (!raw.trim()) continue
    const indent = raw.length - raw.trimStart().length
    const node = { text: raw.trim(), indent, children: [] }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root
}

/**
 * `key: "value"` -> value, quotes stripped. Returns null when absent.
 *
 * A bare `key: |` is a block scalar: the value is the indented lines beneath it,
 * not the pipe. Long prose like `system.instructions` is written that way so it
 * stays readable in the source, and the panel renders it verbatim, so the
 * paragraph breaks have to survive extraction.
 */
function field(node, key) {
  const hit = node?.children.find((c) => c.text.startsWith(`${key}:`))
  if (!hit) return null
  const inline = hit.text.slice(key.length + 1).trim()
  if (inline === '|') {
    return hit.children.map((c) => c.text).join('\n\n')
  }
  return unquote(inline)
}

function unquote(s) {
  const t = s.trim()
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) return t.slice(1, -1)
  return t
}

function child(node, prefix) {
  return node?.children.find((c) => c.text === prefix || c.text.startsWith(prefix))
}

function bool(value) {
  return value === 'True' || value === 'true'
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * `instructions: ->` holds `| spoken guidance` lines, some of them wrapped in a
 * flat `if <condition>:` block. Flattened to blocks so the UI can show the
 * conditional ones as branches, which is the part that surprises people.
 */
function readInstructions(reasoning) {
  const node = child(reasoning, 'instructions:')
  if (!node) return []
  const blocks = []
  let open = null
  for (const line of node.children) {
    if (line.text.startsWith('|')) {
      const text = line.text.slice(1).trim()
      if (open) open.lines.push(text)
      else blocks.push({ condition: null, lines: [text] })
      continue
    }
    if (line.text.startsWith('if ')) {
      open = { condition: line.text.slice(3).replace(/:$/, '').trim(), lines: [] }
      blocks.push(open)
      for (const nested of line.children) {
        if (nested.text.startsWith('|')) open.lines.push(nested.text.slice(1).trim())
      }
      open = null
    }
  }
  return blocks
}

/** `reasoning.actions:` — what the planner is allowed to reach for on a turn. */
function readActionRefs(reasoning) {
  const node = child(reasoning, 'actions:')
  if (!node) return { transitions: [], setters: [], calls: [] }
  const transitions = []
  const setters = []
  const calls = []

  for (const entry of node.children) {
    const [name, ...rest] = entry.text.split(':')
    const body = rest.join(':').trim()
    const description = field(entry, 'description') ?? ''

    const transition = body.match(/@utils\.transition to @subagent\.(\w+)/)
    if (transition) {
      transitions.push({ name: name.trim(), to: transition[1], when: description })
      continue
    }
    if (body.startsWith('@utils.setVariables')) {
      setters.push({
        name: name.trim(),
        description,
        variables: entry.children
          .filter((c) => c.text.startsWith('with '))
          .map((c) => c.text.slice(5).split('=')[0].trim()),
      })
      continue
    }
    const call = body.match(/@actions\.(\w+)/)
    if (call) {
      const gate = entry.children.find((c) => c.text.startsWith('available when '))
      calls.push({
        name: name.trim(),
        action: call[1],
        description,
        availableWhen: gate ? gate.text.slice('available when '.length).trim() : null,
      })
    }
  }
  return { transitions, setters, calls }
}

/** `before_reasoning` / `after_reasoning` — the deterministic part. */
function readGuards(topic, key) {
  const node = child(topic, `${key}:`)
  if (!node) return []
  const out = []
  for (const line of node.children) {
    if (line.text.startsWith('if ')) {
      out.push({
        condition: line.text.slice(3).replace(/:$/, '').trim(),
        then: line.children.map((c) => c.text),
      })
    } else {
      out.push({ condition: null, then: [line.text] })
    }
  }
  return out
}

function readParams(node, key) {
  const holder = child(node, `${key}:`)
  if (!holder) return []
  return holder.children.map((p) => {
    const [name, type] = p.text.split(':')
    return {
      name: name.trim(),
      type: (type ?? '').trim(),
      description: field(p, 'description') ?? '',
      required: bool(field(p, 'is_required')),
    }
  })
}

/** `actions:` at subagent level — the real signatures, Apex or standard. */
function readActionDefs(topic, ownerName) {
  // The last `actions:` child of a subagent is the definition block; the one
  // inside `reasoning:` is the reference list and is read elsewhere.
  const node = topic.children.find((c) => c.text === 'actions:')
  if (!node) return []
  return node.children.map((def) => {
    const target = field(def, 'target') ?? ''
    const apex = target.match(/^apex:\/\/(\w+)/)
    return {
      name: def.text.replace(/:$/, '').trim(),
      label: field(def, 'label') ?? '',
      description: field(def, 'description') ?? '',
      target,
      kind: apex ? 'Apex' : target.startsWith('standardInvocableAction') ? 'Standard' : 'Other',
      apexClass: apex ? apex[1] : null,
      progressMessage: field(def, 'progress_indicator_message') ?? '',
      requiresConfirmation: bool(field(def, 'require_user_confirmation')),
      owner: ownerName,
      inputs: readParams(def, 'inputs'),
      outputs: readParams(def, 'outputs'),
    }
  })
}

function readTopic(node) {
  const isRouter = node.text.startsWith('start_agent ')
  const name = node.text.replace(/^(start_agent|subagent)\s+/, '').replace(/:$/, '').trim()
  const reasoning = child(node, 'reasoning:')
  const refs = reasoning ? readActionRefs(reasoning) : { transitions: [], setters: [], calls: [] }
  return {
    name,
    label: field(node, 'label') ?? name,
    description: field(node, 'description') ?? '',
    isRouter,
    instructions: reasoning ? readInstructions(reasoning) : [],
    beforeReasoning: readGuards(node, 'before_reasoning'),
    afterReasoning: readGuards(node, 'after_reasoning'),
    ...refs,
    actionDefs: readActionDefs(node, name),
  }
}

/* ------------------------------------------------------------- assembling --- */

/** `emergency-and-safety-policy.txt` -> `Emergency and safety policy`. */
function prettyDoc(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  return base.charAt(0).toUpperCase() + base.slice(1)
}

function knowledgeDocs(key) {
  const dir = join(KNOWLEDGE, key)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map(prettyDoc)
}

function buildBlueprint(agent, agentFile) {
  const tree = parseTree(readFileSync(agentFile, 'utf8'))
  const system = child(tree, 'system:')
  const config = child(tree, 'config:')
  const knowledge = child(tree, 'knowledge:')
  const voice = child(tree, 'modality voice:')
  const messages = child(system, 'messages:')

  const topics = tree.children
    .filter((c) => c.text.startsWith('start_agent ') || c.text.startsWith('subagent '))
    .map(readTopic)

  const variables = (child(tree, 'variables:')?.children ?? []).map((v) => {
    const [name, decl] = v.text.split(':')
    const kind = (decl ?? '').trim()
    return {
      name: name.trim(),
      // `mutable string = ""` and `linked string` both land here; keep the
      // declaration verbatim, it is what a builder sees.
      kind: kind.replace(/\s*=\s*.*$/, ''),
      linkedTo: field(v, 'source'),
      description: field(v, 'description') ?? '',
    }
  })

  const actions = topics.flatMap((t) => t.actionDefs)
  for (const topic of topics) delete topic.actionDefs

  return {
    key: agent.key,
    label: agent.label,
    // `default_agent_user` is deliberately not carried through — it is an org
    // username and no prospect needs it.
    developerName: field(config, 'developer_name'),
    agentLabel: field(config, 'agent_label'),
    agentType: field(config, 'agent_type'),
    description: field(config, 'description'),
    systemInstructions: field(system, 'instructions'),
    welcome: field(messages, 'welcome'),
    voice: voice && {
      voiceId: field(voice, 'voice_id'),
      speed: num(field(voice, 'outbound_speed')),
      stability: num(field(voice, 'outbound_stability')),
      similarity: num(field(voice, 'outbound_similarity')),
    },
    knowledge: knowledge && {
      ragFeatureConfigId: field(knowledge, 'rag_feature_config_id'),
      citationsEnabled: bool(field(knowledge, 'citations_enabled')),
      documents: knowledgeDocs(agent.key),
    },
    topics,
    actions,
    variables,
    stats: {
      topics: topics.length,
      actions: actions.length,
      apexActions: actions.filter((a) => a.kind === 'Apex').length,
      variables: variables.length,
      // The size of the thing being demoed, in the unit a builder recognises.
      agentScriptLines: readFileSync(agentFile, 'utf8').split('\n').length,
    },
  }
}

/* ------------------------------------------------------------------- main --- */

const { AGENTS } = await import(join(ROOT, 'lib/agents.ts'))

let stale = 0
mkdirSync(OUT_DIR, { recursive: true })

for (const agent of AGENTS) {
  // Roadmap tiles have no agent yet — nothing to extract until they go live.
  if (!agent.live) continue
  // The registry key is the route segment; the bundle is named for the agent.
  // Match on separator-insensitive prefix: the key uses hyphens (financial-services)
  // and the bundle uses underscores (Financial_Services_Voice_Agent).
  const norm = (s) => s.toLowerCase().replace(/[-_]+/g, '_')
  const bundles = existsSync(BUNDLES) ? readdirSync(BUNDLES) : []
  const bundle = bundles.find((b) => norm(b).startsWith(norm(agent.key)))
  if (!bundle) {
    console.error(`✗ ${agent.key}: no authoring bundle under ${BUNDLES} starts with "${agent.key}"`)
    process.exitCode = 1
    continue
  }

  const agentFile = join(BUNDLES, bundle, `${bundle}.agent`)
  if (!existsSync(agentFile)) {
    console.error(`✗ ${agent.key}: ${agentFile} is missing`)
    process.exitCode = 1
    continue
  }

  const blueprint = buildBlueprint(agent, agentFile)
  const json = `${JSON.stringify(blueprint, null, 2)}\n`
  const out = join(OUT_DIR, `${agent.key}.json`)
  const current = existsSync(out) ? readFileSync(out, 'utf8') : null

  if (current === json) {
    console.log(`= ${agent.key}: up to date (${blueprint.stats.topics} topics, ${blueprint.stats.actions} actions)`)
    continue
  }

  if (CHECK) {
    console.error(`✗ ${agent.key}: public/blueprint/${agent.key}.json is stale. Run: npm run blueprint`)
    stale++
    continue
  }

  writeFileSync(out, json)
  const size = (json.length / 1024).toFixed(1)
  console.log(
    `✓ ${agent.key}: ${blueprint.stats.topics} topics, ${blueprint.stats.actions} actions ` +
      `(${blueprint.stats.apexActions} Apex), ${blueprint.stats.variables} variables → ${size} KB`,
  )
}

if (stale) {
  console.error(`\n${stale} blueprint(s) out of date. The .agent file changed without re-extracting.`)
  process.exit(1)
}
