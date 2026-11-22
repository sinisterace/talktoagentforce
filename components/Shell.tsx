'use client'

import DotGrid from './reactbits/DotGrid'

/**
 * Page frame: the dotted background, fixed behind everything, plus a content
 * column above it. Every screen renders inside this so the background never
 * unmounts and re-initialises its canvas on navigation.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="shell__bg">
        <DotGrid
          dotSize={10}
          gap={26}
          baseColor="#151b29"
          activeColor="#2f6ef0"
          proximity={130}
          shockRadius={220}
          shockStrength={4}
        />
      </div>
      <div className="shell__content">{children}</div>
    </div>
  )
}
