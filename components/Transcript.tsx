'use client'

import { useEffect, useRef, useState } from 'react'

import type { Turn } from '@/lib/use-call'

/**
 * Screen 3 — the transcript, a collapsible sheet under the strands.
 *
 * Collapsed by default. The point of the demo is that the visitor is *talking*;
 * a wall of text on screen invites them to read instead of speak. It stays one
 * tap away because people do want to check what the agent heard, especially
 * after giving an address or a phone number.
 */
export default function Transcript({ turns, interim }: { turns: Turn[]; interim: string }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Pin to the newest turn while open, the way a chat log behaves.
  useEffect(() => {
    if (!open) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open, turns, interim])

  return (
    <section className="sheet glass">
      <button
        type="button"
        className="sheet__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sheet__title">Transcript</span>
        <span className="sheet__count">{turns.length}</span>
        <span className={`sheet__chev${open ? ' sheet__chev--open' : ''}`} aria-hidden="true">
          ⌃
        </span>
      </button>

      {open && (
        <div className="sheet__body" ref={bodyRef}>
          {turns.length === 0 && !interim && (
            <p className="sheet__empty">Nothing said yet. Start talking and it will appear here.</p>
          )}
          {turns.map((turn) => (
            <p key={turn.id} className={`turn turn--${turn.who}`}>
              <span className="turn__who">{turn.who === 'agent' ? 'Agent' : 'You'}</span>
              {turn.text}
            </p>
          ))}
          {interim && (
            <p className="turn turn--visitor" style={{ opacity: 0.55 }}>
              <span className="turn__who">You</span>
              {interim}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
