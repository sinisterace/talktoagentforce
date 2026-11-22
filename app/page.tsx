'use client'

/**
 * Screen 1 — the template library, and the switch into a call.
 *
 * The agent list comes from `/api/config` rather than the bundle, so adding an
 * industry is a registry edit plus a deploy, with no client rebuild needed for
 * the copy. One tile today; the grid is already written for ten.
 *
 * Both screens live in one client component on purpose: routing to /call/[key]
 * would unmount the WebGL background and re-create three GL contexts on every
 * navigation, which is visible as a flash on a phone.
 */

import { useEffect, useState } from 'react'

import CallScreen from '@/components/CallScreen'
import SpecularButton from '@/components/reactbits/SpecularButton'
import Shell from '@/components/Shell'
import type { PublicAgent, PublicConfig } from '@/lib/client-types'

export default function Page() {
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [active, setActive] = useState<PublicAgent | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/config')
      .then(async (r) => {
        const body = (await r.json()) as PublicConfig & { error?: string }
        if (!r.ok) throw new Error(body.error ?? `config ${r.status}`)
        return body
      })
      .then((body) => {
        if (live) setConfig(body)
      })
      .catch((err: unknown) => {
        if (live) setConfigError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [])

  if (active && config) {
    return (
      <Shell>
        <CallScreen agent={active} config={config} onExit={() => setActive(null)} />
      </Shell>
    )
  }

  return (
    <Shell>
      <main className="home">
        <div>
          <p className="home__eyebrow">Agentforce templates</p>
          <h1 className="home__title">
            Talk to an <em>Agentforce agent</em>. No download, no sign-up.
          </h1>
          <p className="home__lede">
            Pick an industry, tap once, and speak. Every agent here is a real Agentforce agent
            running in a Salesforce org — and you can open its configuration mid-call to see exactly
            how it was built.
          </p>
        </div>

        <div className="home__grid">
          {config?.agents.map((agent) => (
            <SpecularButton
              key={agent.key}
              className="specular-button--card tile"
              size="md"
              radius={16}
              lineColor={agent.accent}
              onClick={() => setActive(agent)}
              aria-label={`Call the ${agent.label}`}
              style={{ '--accent': agent.accent } as React.CSSProperties}
            >
              <span className="tile__row">
                {/* The art is decorative — the label beside it already names the
                    industry, so alt text would just be read out twice. */}
                <img className="tile__icon" src={agent.icon.tile} alt="" width={56} height={56} />
                <span className="tile__label">{agent.label}</span>
                <span className="tile__go" aria-hidden="true">
                  ›
                </span>
              </span>
              <span className="tile__blurb">{agent.blurb}</span>
            </SpecularButton>
          ))}

          {/* Not buttons: there is nothing to call yet, and a disabled <button>
              is still a tab stop that leads nowhere. */}
          {config?.soon.map((agent) => (
            <div
              key={agent.key}
              className="tile tile--soon"
              style={{ '--accent': agent.accent } as React.CSSProperties}
            >
              <span className="tile__row">
                <img className="tile__icon" src={agent.icon.tile} alt="" width={56} height={56} />
                <span className="tile__label">{agent.label}</span>
                <span className="tile__soon">Soon</span>
              </span>
              <span className="tile__blurb">{agent.blurb}</span>
            </div>
          ))}
        </div>

        {!config && !configError && <p className="home__soon">Loading the template library…</p>}

        {configError && (
          <div className="banner banner--error" role="alert">
            <span>The template library could not be loaded ({configError}).</span>
          </div>
        )}

        <p className="home__foot">
          Voice in your browser, reasoning in Agentforce. Conversations are transcribed to the
          Salesforce org behind the demo so the agent can be improved; don&apos;t share anything
          you wouldn&apos;t put in a support ticket.
        </p>
      </main>
    </Shell>
  )
}
