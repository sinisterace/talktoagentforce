'use client'

/**
 * Screen 4 — "Look inside".
 *
 * Shows the prospect the actual agent configuration: the topic graph and its
 * routing conditions, every action with its real Apex class and parameter list,
 * the authored instruction text, and the voice + knowledge setup. Four tabs
 * because that is how a builder thinks about an agent.
 *
 * The data is `public/blueprint/<key>.json`, generated at build time by
 * scripts/extract-blueprint.mjs from the `.agent` file itself. Nothing here is
 * a mock-up or a paraphrase — it is parsed from the file that gets deployed,
 * which is the only version a prospect would find credible.
 *
 * Available before, during and after a call: the fetch is independent of the
 * conversation, so opening this panel mid-call cannot disturb the agent.
 *
 * Everything is collapsed by default. Expanded, this agent's Topics tab is about
 * 7,700px of text against a 560px panel — fourteen screens of scrolling, which
 * in a live demo means the prospect never sees topic seven and cannot tell how
 * many there were. Collapsed, all seven fit on one screen with their shape
 * (hands-offs, calls, guards) on the summary line, and the one being discussed
 * is a single tap away.
 */

import { useEffect, useMemo, useState } from 'react'

import type {
  Blueprint,
  BlueprintAction,
  BlueprintParam,
  BlueprintTopic,
  Guard,
  InstructionBlock,
} from '@/lib/client-types'

type Tab = 'topics' | 'actions' | 'instructions' | 'voice'

const TABS: { id: Tab; label: string }[] = [
  { id: 'topics', label: 'Topics' },
  { id: 'actions', label: 'Actions' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'voice', label: 'Voice & knowledge' },
]

/**
 * A collapsed card. Native <details> rather than a `useState` toggle: it brings
 * keyboard operation, the correct roles, and in-page find (browsers expand a
 * closed <details> to reveal a match) for free.
 *
 * `meta` is the point of the collapsed state — a row of names alone tells the
 * prospect nothing, whereas "6 hand-offs · 2 actions" tells them where the
 * complexity is before they open anything.
 */
function Fold({
  title,
  tags,
  meta,
  open = false,
  children,
}: {
  title: string
  tags?: React.ReactNode
  meta?: string[]
  open?: boolean
  children: React.ReactNode
}) {
  return (
    <details className="fold" open={open}>
      <summary className="fold__summary">
        <span className="fold__chev" aria-hidden="true">
          ›
        </span>
        <span className="fold__head">
          <span className="fold__title">
            <span className="card__name">{title}</span>
            {tags}
          </span>
          {meta && meta.length > 0 && <span className="fold__meta">{meta.join(' · ')}</span>}
        </span>
      </summary>
      <div className="fold__body">{children}</div>
    </details>
  )
}

/** "1 thing" / "2 things", so summary lines do not read "1 actions". */
function count(n: number, one: string, many = `${one}s`): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? one : many}`
}

export default function BlueprintPanel({
  agentKey,
  label,
  onClose,
}: {
  agentKey: string
  label: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('topics')
  const [bp, setBp] = useState<Blueprint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    fetch(`/blueprint/${agentKey}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`blueprint ${r.status}`)
        return r.json() as Promise<Blueprint>
      })
      .then((data) => {
        if (live) setBp(data)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [agentKey])

  // Escape closes it. On desktop this is a rail with no scrim to tap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <button
        type="button"
        className="bp__scrim"
        aria-label="Close the configuration panel"
        onClick={onClose}
      />
      <aside className="bp__panel" aria-label={`${label} configuration`}>
        <header className="bp__head">
          <div className="bp__titles">
            <h2 className="bp__title">Inside {label}</h2>
            <p className="bp__sub">
              Read straight from the agent&apos;s Agent Script file — the same configuration that runs
              this call.
            </p>
          </div>
          <button type="button" className="bp__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {bp && (
          <div className="bp__stats">
            <span className="chip">{bp.stats.topics} topics</span>
            <span className="chip">{bp.stats.actions} actions</span>
            <span className="chip chip--apex">{bp.stats.apexActions} Apex</span>
            <span className="chip">{bp.stats.variables} variables</span>
            <span className="chip">{bp.stats.agentScriptLines} lines</span>
          </div>
        )}

        <nav className="bp__tabs" aria-label="Configuration sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`bp__tab${tab === t.id ? ' bp__tab--on' : ''}`}
              aria-current={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Only where there is a list long enough to need it. On Voice &
            knowledge there are four cards and a filter would be furniture. */}
        {bp && tab !== 'voice' && (
          <div className="bp__filter">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, action or wording…"
              aria-label="Filter the configuration"
            />
            {query && (
              <button
                type="button"
                className="bp__filter-clear"
                onClick={() => setQuery('')}
                aria-label="Clear the filter"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div className="bp__scroll">
          {error && <p className="bp__note">Could not load the configuration ({error}).</p>}
          {!bp && !error && <p className="bp__note">Loading the configuration…</p>}
          {bp && tab === 'topics' && <Topics bp={bp} query={query} />}
          {bp && tab === 'actions' && <Actions bp={bp} query={query} />}
          {bp && tab === 'instructions' && <Instructions bp={bp} query={query} />}
          {bp && tab === 'voice' && <VoiceAndKnowledge bp={bp} />}
        </div>
      </aside>
    </>
  )
}

/* ------------------------------------------------------------------- topics --- */

/** Everything about a topic that a filter should be able to match. */
function topicText(t: BlueprintTopic): string {
  return [
    t.name,
    t.label,
    t.description,
    ...t.transitions.map((x) => `${x.to} ${x.when}`),
    ...t.calls.map((x) => `${x.action} ${x.description}`),
    ...t.setters.flatMap((x) => [x.name, x.description, ...x.variables]),
    ...t.instructions.flatMap((b) => b.lines),
  ]
    .join(' ')
    .toLowerCase()
}

function Topics({ bp, query }: { bp: Blueprint; query: string }) {
  const q = query.trim().toLowerCase()
  const topics = useMemo(
    () => (q ? bp.topics.filter((t) => topicText(t).includes(q)) : bp.topics),
    [bp.topics, q],
  )

  return (
    <>
      <p className="bp__note">
        Each topic is a specialist. The router reads what you said and hands the conversation to one
        of them, then that topic keeps it until the job is done.
      </p>

      {topics.length === 0 && <p className="bp__empty">No topic mentions “{query}”.</p>}

      {topics.map((topic) => (
        <Fold
          key={topic.name}
          title={topic.name}
          tags={topic.isRouter && <span className="tag tag--router">router</span>}
          // A search narrowed to one card should show it, not make the visitor
          // open the only result by hand.
          open={topics.length === 1 && q.length > 0}
          meta={
            [
              count(topic.transitions.length, 'hand-off'),
              count(topic.calls.length, 'action'),
              count(topic.beforeReasoning.length + topic.afterReasoning.length, 'guard'),
            ].filter((s): s is string => s !== null)
          }
        >
          {topic.description && <p className="card__desc">{topic.description}</p>}

          {topic.transitions.length > 0 && (
            <>
              <p className="card__sub">Hands off to</p>
              <ul className="lines">
                {topic.transitions.map((t) => (
                  <li key={t.name}>
                    <code>{t.to}</code>
                    {t.when ? ` — ${t.when}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}

          {topic.calls.length > 0 && (
            <>
              <p className="card__sub">Calls</p>
              <ul className="lines">
                {topic.calls.map((c) => (
                  <li key={c.name}>
                    <code>{c.action}</code>
                    {c.description ? ` — ${c.description}` : ''}
                    {c.availableWhen && <code className="cond">available when {c.availableWhen}</code>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {topic.setters.length > 0 && (
            <>
              <p className="card__sub">Remembers</p>
              <ul className="lines">
                {topic.setters.map((s) => (
                  <li key={s.name}>
                    {s.variables.length ? s.variables.join(', ') : s.name}
                    {s.description ? ` — ${s.description}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* before/after_reasoning is the deterministic half of an agent —
              worth showing, because "the LLM decides everything" is the usual
              assumption in the room. */}
          {topic.beforeReasoning.length > 0 && (
            <GuardList title="Runs before it thinks" guards={topic.beforeReasoning} />
          )}
          {topic.afterReasoning.length > 0 && (
            <GuardList title="Runs after it thinks" guards={topic.afterReasoning} />
          )}
        </Fold>
      ))}
    </>
  )
}

function GuardList({ title, guards }: { title: string; guards: Guard[] }) {
  return (
    <>
      <p className="card__sub">{title}</p>
      {guards.map((g, i) => (
        <div key={i}>
          {g.condition && <code className="cond">if {g.condition}</code>}
          <ul className="lines">
            {g.then.map((line, j) => (
              <li key={j}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

/* ------------------------------------------------------------------ actions --- */

/** Everything about an action that a filter should be able to match. */
function actionText(a: BlueprintAction): string {
  return [
    a.name,
    a.label,
    a.description,
    a.target,
    a.kind,
    a.apexClass ?? '',
    a.owner,
    ...a.inputs.map((p) => `${p.name} ${p.description}`),
    ...a.outputs.map((p) => `${p.name} ${p.description}`),
  ]
    .join(' ')
    .toLowerCase()
}

function Actions({ bp, query }: { bp: Blueprint; query: string }) {
  const q = query.trim().toLowerCase()
  const actions = useMemo(
    () => (q ? bp.actions.filter((a) => actionText(a).includes(q)) : bp.actions),
    [bp.actions, q],
  )

  return (
    <>
      <p className="bp__note">
        Actions are the only way the agent touches Salesforce. Each one has a fixed signature, so the
        agent can decide <em>whether</em> to call it but not what shape the call takes.
      </p>

      {actions.length === 0 && <p className="bp__empty">No action mentions “{query}”.</p>}

      {actions.map((action) => (
        <Fold
          key={action.name}
          title={action.name}
          open={actions.length === 1 && q.length > 0}
          tags={
            <>
              <span className={`tag${action.kind === 'Apex' ? ' tag--apex' : ''}`}>
                {action.kind}
              </span>
              {action.requiresConfirmation && <span className="tag">confirms first</span>}
            </>
          }
          meta={
            [
              count(action.inputs.length, 'input'),
              count(action.outputs.length, 'output'),
              action.owner,
            ].filter((s): s is string => s !== null)
          }
        >
          {action.description && <p className="card__desc">{action.description}</p>}

          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Owned by</dt>
            <dd>{action.owner}</dd>
            {action.apexClass && (
              <>
                <dt>Apex class</dt>
                <dd>{action.apexClass}</dd>
              </>
            )}
            {action.progressMessage && (
              <>
                <dt>Says while working</dt>
                <dd>{action.progressMessage}</dd>
              </>
            )}
          </dl>

          {action.inputs.length > 0 && <Params title="Inputs" params={action.inputs} />}
          {action.outputs.length > 0 && <Params title="Outputs" params={action.outputs} />}
        </Fold>
      ))}
    </>
  )
}

function Params({ title, params }: { title: string; params: BlueprintParam[] }) {
  return (
    <>
      <p className="card__sub">{title}</p>
      <div className="params">
        {params.map((p) => (
          <span key={p.name} className="param" title={p.description}>
            <b>{p.name}</b> {p.type}
            {p.required && <i> *</i>}
          </span>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------- instructions --- */

function Instructions({ bp, query }: { bp: Blueprint; query: string }) {
  const q = query.trim().toLowerCase()

  const authored = useMemo(
    () =>
      bp.topics
        .filter((t) => t.instructions.length > 0)
        .filter(
          (t) =>
            !q ||
            t.name.toLowerCase().includes(q) ||
            t.instructions.some((b) => b.lines.some((l) => l.toLowerCase().includes(q))),
        ),
    [bp.topics, q],
  )

  const showSystem =
    !!bp.systemInstructions && (!q || bp.systemInstructions.toLowerCase().includes(q))

  return (
    <>
      <p className="bp__note">
        The agent&apos;s behaviour is written in plain English, not code. Lines in an amber box only
        apply when their condition holds — that is how one topic handles several situations.
      </p>

      {!showSystem && authored.length === 0 && (
        <p className="bp__empty">No instruction mentions “{query}”.</p>
      )}

      {showSystem && bp.systemInstructions && (
        <Fold
          title="system"
          tags={<span className="tag">applies everywhere</span>}
          open={authored.length === 0}
          meta={[count(bp.systemInstructions.split('\n').filter(Boolean).length, 'line') ?? '']}
        >
          <pre className="pre" style={{ marginTop: 12 }}>
            {bp.systemInstructions}
          </pre>
        </Fold>
      )}

      {authored.map((topic) => (
        <Fold
          key={topic.name}
          title={topic.name}
          open={!showSystem && authored.length === 1 && q.length > 0}
          tags={topic.isRouter && <span className="tag tag--router">router</span>}
          meta={
            [
              count(
                topic.instructions.reduce((n, b) => n + b.lines.length, 0),
                'line',
              ),
              count(topic.instructions.filter((b) => b.condition).length, 'condition'),
            ].filter((s): s is string => s !== null)
          }
        >
          <InstructionBlocks blocks={topic.instructions} />
        </Fold>
      ))}
    </>
  )
}

function InstructionBlocks({ blocks }: { blocks: InstructionBlock[] }) {
  return (
    <div style={{ marginTop: 10 }}>
      {blocks.map((block, i) => (
        <div key={i}>
          {block.condition && <code className="cond">if {block.condition}</code>}
          <ul className="lines">
            {block.lines.map((line, j) => (
              <li key={j}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------- voice + knowledge --- */

function VoiceAndKnowledge({ bp }: { bp: Blueprint }) {
  return (
    <>
      <article className="card">
        <div className="card__head">
          <span className="card__name">Agent</span>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>API name</dt>
          <dd>{bp.developerName ?? '—'}</dd>
          <dt>Type</dt>
          <dd>{bp.agentType ?? '—'}</dd>
          {bp.description && (
            <>
              <dt>Purpose</dt>
              <dd style={{ fontFamily: 'var(--font)' }}>{bp.description}</dd>
            </>
          )}
        </dl>
      </article>

      {bp.voice && (
        <article className="card">
          <div className="card__head">
            <span className="card__name">Voice</span>
          </div>
          <p className="card__desc">
            These are the agent&apos;s own voice settings. This browser demo uses the same ones, so it
            sounds like the phone deployment would.
          </p>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Voice id</dt>
            <dd>{bp.voice.voiceId ?? '—'}</dd>
            <dt>Speed</dt>
            <dd>{bp.voice.speed ?? '—'}</dd>
            <dt>Stability</dt>
            <dd>{bp.voice.stability ?? '—'}</dd>
            <dt>Similarity</dt>
            <dd>{bp.voice.similarity ?? '—'}</dd>
          </dl>
        </article>
      )}

      {bp.knowledge && (
        <article className="card">
          <div className="card__head">
            <span className="card__name">Knowledge</span>
            <span className="tag">{bp.knowledge.documents.length} documents</span>
          </div>
          <p className="card__desc">
            General questions are answered out of these documents rather than from the model&apos;s
            memory, which is what keeps the answers about this business specifically.
          </p>
          <ul className="lines">
            {bp.knowledge.documents.map((doc) => (
              <li key={doc}>{doc}</li>
            ))}
          </ul>
        </article>
      )}

      <article className="card">
        <div className="card__head">
          <span className="card__name">Variables</span>
          <span className="tag">{bp.variables.length}</span>
        </div>
        <p className="card__desc">
          What the agent carries through the conversation. Linked variables come from the channel
          itself, not from anything you say.
        </p>
        <div className="params" style={{ marginTop: 12 }}>
          {bp.variables.map((v) => (
            <span key={v.name} className="param" title={v.description}>
              <b>{v.name}</b> {v.kind}
              {v.linkedTo && <i> ← {v.linkedTo}</i>}
            </span>
          ))}
        </div>
      </article>
    </>
  )
}
