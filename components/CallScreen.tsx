'use client'

/**
 * Screens 2 and 5 — the call itself, and the states it has to survive.
 *
 * The strands fill the space between the header and the controls and react to
 * whoever is making noise: cool blue while the visitor talks (mic level), warm
 * violet while the agent talks (TTS output level), amber while the planner is
 * thinking. Colour alone tells you whose turn it is, which matters because the
 * visitor is looking at a phone at arm's length, not reading labels.
 *
 * The two required states:
 *   - the pre-rendered greeting plays the instant the button is tapped, never
 *     waiting on the event stream (see lib/use-call.ts `start`);
 *   - 'reconnecting' shows an amber banner saying replies are paused, because
 *     a phone waking from sleep drops the stream routinely and silence with no
 *     explanation is indistinguishable from a broken agent.
 */

import { useEffect, useState } from 'react'

import BlueprintPanel from './BlueprintPanel'
import SpecularButton from './reactbits/SpecularButton'
import Strands from './reactbits/Strands'
import Transcript from './Transcript'
import type { PublicAgent, PublicConfig } from '@/lib/client-types'
import { useCall } from '@/lib/use-call'
import { Voice } from '@/lib/voice'

/**
 * Short label for the state line under the agent name.
 *
 * `live` drives the pulsing dot: it marks the states where the agent is busy and
 * the visitor should wait. A dot that pulses through 'Call ended' and 'Muted' too
 * is just decoration, and stops carrying information in the states that matter.
 */
function stateLabel(
  status: string,
  phase: string,
  muted: boolean,
  started: boolean,
): {
  text: string
  tone: 'listening' | 'speaking' | 'thinking' | 'error' | ''
  live: boolean
} {
  // Before the first tap nothing is connecting yet — 'idle' here means waiting
  // for the visitor, not waiting for the network.
  if (!started && status === 'idle') return { text: 'Ready to call', tone: '', live: false }
  if (status === 'error') return { text: 'Disconnected', tone: 'error', live: false }
  if (status === 'reconnecting') return { text: 'Reconnecting', tone: 'thinking', live: true }
  if (status === 'ended') return { text: 'Call ended', tone: '', live: false }
  if (status === 'connecting' || status === 'idle')
    return { text: 'Connecting', tone: 'thinking', live: true }
  if (phase === 'speaking') return { text: 'Speaking', tone: 'speaking', live: true }
  if (phase === 'thinking') return { text: 'Thinking', tone: 'thinking', live: true }
  if (muted) return { text: 'Muted', tone: '', live: false }
  if (phase === 'listening') return { text: 'Listening', tone: 'listening', live: true }
  return { text: 'Connected', tone: '', live: false }
}

export default function CallScreen({
  agent,
  config,
  onExit,
}: {
  agent: PublicAgent
  config: PublicConfig
  onExit: () => void
}) {
  const { state, start, sendText, end, muted, toggleMute, driveRef, colors } = useCall(agent, config)
  const [started, setStarted] = useState(false)
  const [blueprintOpen, setBlueprintOpen] = useState(false)
  const [draft, setDraft] = useState('')

  // Warm the browser cache for the greeting MP3 while the visitor reads the
  // screen. The whole cold-start trick depends on this file being instant.
  useEffect(() => {
    Voice.prime(agent.greetingAudio)
  }, [agent.greetingAudio])

  const live = started && state.status !== 'ended'
  const label = stateLabel(state.status, state.phase, muted, started)

  const caption = state.interim || state.caption

  const handleStart = () => {
    setStarted(true)
    void start()
  }

  const handleEnd = () => {
    end()
    setStarted(false)
  }

  return (
    <div
      className={`call${blueprintOpen ? ' call--with-bp' : ''}`}
      style={{ '--accent': agent.accent } as React.CSSProperties}
    >
      <header className="call__topbar">
        <button type="button" className="call__back" onClick={onExit} aria-label="Back to templates">
          ‹ Templates
        </button>
        <img className="call__icon" src={agent.icon.chip} alt="" width={30} height={30} />
        <div className="call__heading">
          <div className="call__name">{agent.label}</div>
          <div className={`call__state${label.tone ? ` call__state--${label.tone}` : ''}`}>
            {/* The dot animates only while something is actually happening, so
                movement in the corner of the eye means the agent is working. */}
            <span
              className={`call__dot${label.live ? ' call__dot--live' : ''}`}
              aria-hidden="true"
            />
            {label.text}
          </div>
        </div>
      </header>

      {/* Screen 5, state one: a dropped stream is routine, so the wording is
          about what is happening, not about a failure. */}
      {state.status === 'reconnecting' && (
        <div className="banner banner--info" role="status">
          <span className="banner__dot" aria-hidden="true" />
          <span>
            Reconnecting to the agent. Replies are paused for a moment — anything you say now will be
            sent when it comes back.
          </span>
        </div>
      )}

      {state.status === 'error' && state.error && (
        <div className="banner banner--error" role="alert">
          <span>{state.error}</span>
        </div>
      )}

      {state.notice && (
        <div className="banner" role="status">
          <span>{state.notice}</span>
        </div>
      )}

      <div className="call__body">
        <div className="call__stage">
          <div className="call__strands" aria-hidden="true">
            <Strands
              colors={colors}
              driveRef={driveRef}
              count={live ? 5 : 3}
              taper={2.6}
              scale={1.35}
              saturation={1.45}
              opacity={live ? 1 : 0.5}
            />
          </div>

          {!live ? (
            /* The demo's real failure mode is the visitor tapping and then
               freezing, because "just talk" assumes they arrived with a problem
               in mind. Giving them three sentences they can read out loud turns
               a blank prompt into a script. */
            <div className="call__intro">
              <p className="call__caption">
                {state.status === 'ended'
                  ? 'Call ended. Tap to start another.'
                  : 'Tap to call, then just talk. The agent answers straight away.'}
              </p>
              {agent.starters.length > 0 && (
                <div className="starters">
                  <p className="starters__label">Try saying</p>
                  <ul className="starters__list">
                    {agent.starters.map((line) => (
                      <li key={line} className="starters__item">
                        “{line}”
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className={`call__caption${state.interim ? ' call__caption--interim' : ''}`}>
              {caption}
            </p>
          )}
        </div>

        {/* Typing is the fallback when speech recognition is unavailable (Firefox)
            or the mic was denied, and the escape hatch in a noisy room. */}
        {live && (
          <form
            className="call__composer"
            onSubmit={(e) => {
              e.preventDefault()
              sendText(draft)
              setDraft('')
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="…or type instead"
              aria-label="Type a message to the agent"
              enterKeyHint="send"
            />
            <SpecularButton size="sm" radius={999} onClick={() => undefined} type="submit">
              Send
            </SpecularButton>
          </form>
        )}

        <div className="call__controls">
          {!live ? (
            <SpecularButton
              size="lg"
              radius={999}
              autoAnimate
              lineColor="#22d3ee"
              baseColor="#1e293b"
              onClick={handleStart}
            >
              {state.status === 'ended' ? 'Call again' : `Call the ${agent.label}`}
            </SpecularButton>
          ) : (
            <>
              <SpecularButton
                size="md"
                radius={999}
                onClick={toggleMute}
                aria-pressed={muted}
                disabled={!state.micReady}
                title={state.micReady ? undefined : 'The microphone is not available'}
              >
                {muted ? 'Unmute' : 'Mute'}
              </SpecularButton>
              <SpecularButton
                size="md"
                radius={999}
                className="call__hangup"
                lineColor="#f87171"
                baseColor="#3b1d24"
                onClick={handleEnd}
              >
                Hang up
              </SpecularButton>
            </>
          )}

          <SpecularButton
            size="md"
            radius={999}
            onClick={() => setBlueprintOpen((v) => !v)}
            aria-expanded={blueprintOpen}
          >
            Look inside
          </SpecularButton>
        </div>
      </div>

      <Transcript turns={state.turns} interim={state.interim} />

      {blueprintOpen && (
        <BlueprintPanel
          agentKey={agent.key}
          label={agent.label}
          onClose={() => setBlueprintOpen(false)}
        />
      )}
    </div>
  )
}
