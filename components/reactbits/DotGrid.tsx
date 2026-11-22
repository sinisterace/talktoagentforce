'use client'

/**
 * DotGrid — the dotted page background.
 *
 * Source: react-bits (https://www.reactbits.dev/backgrounds/dot-grid),
 * MIT + Commons Clause, © David Haz. Ported to TypeScript with three changes:
 *
 *  1. The draw loop stops when the tab is hidden and when nothing is moving.
 *     The original repaints every dot every frame forever; on a phone left on
 *     the home screen that is a warm battery for a static image.
 *  2. `prefers-reduced-motion` disables the pointer/click physics. The grid
 *     still draws, it just doesn't get shoved around.
 *  3. Pointer events are listened to as `pointermove`, not `mousemove`, so a
 *     finger drag ripples the dots on a touchscreen too.
 */

import { gsap } from 'gsap'
import { InertiaPlugin } from 'gsap/InertiaPlugin'
import { useRef, useEffect, useCallback, useMemo, type CSSProperties } from 'react'

import './DotGrid.css'

gsap.registerPlugin(InertiaPlugin)

type Dot = {
  cx: number
  cy: number
  xOffset: number
  yOffset: number
  _inertiaApplied: boolean
}

export type DotGridProps = {
  dotSize?: number
  gap?: number
  baseColor?: string
  activeColor?: string
  proximity?: number
  speedTrigger?: number
  shockRadius?: number
  shockStrength?: number
  maxSpeed?: number
  resistance?: number
  returnDuration?: number
  className?: string
  style?: CSSProperties
}

function throttle<A extends unknown[]>(func: (...args: A) => void, limit: number) {
  let lastCall = 0
  return (...args: A) => {
    const now = performance.now()
    if (now - lastCall >= limit) {
      lastCall = now
      func(...args)
    }
  }
}

function hexToRgb(hex: string) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
  if (!m) return { r: 0, g: 0, b: 0 }
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

export default function DotGrid({
  dotSize = 12,
  gap = 28,
  baseColor = '#1d2436',
  activeColor = '#3b82f6',
  proximity = 140,
  speedTrigger = 100,
  shockRadius = 250,
  shockStrength = 5,
  maxSpeed = 5000,
  resistance = 750,
  returnDuration = 1.5,
  className = '',
  style,
}: DotGridProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dotsRef = useRef<Dot[]>([])
  const pointerRef = useRef({ x: -9999, y: -9999, vx: 0, vy: 0, speed: 0, lastTime: 0, lastX: 0, lastY: 0 })
  /**
   * Frames still owed to the canvas. Any pointer or tween activity tops it up;
   * when it runs out the loop idles instead of repainting an unchanged grid.
   */
  const dirtyRef = useRef(2)

  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor])
  const activeRgb = useMemo(() => hexToRgb(activeColor), [activeColor])

  const circlePath = useMemo(() => {
    if (typeof window === 'undefined' || !window.Path2D) return null
    const p = new window.Path2D()
    p.arc(0, 0, dotSize / 2, 0, Math.PI * 2)
    return p
  }, [dotSize])

  const buildGrid = useCallback(() => {
    const wrap = wrapperRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const { width, height } = wrap.getBoundingClientRect()
    // Capped: a 3x-dpr phone would otherwise fill thousands of extra dots.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)
    }

    const cols = Math.floor((width + gap) / (dotSize + gap))
    const rows = Math.floor((height + gap) / (dotSize + gap))
    const cell = dotSize + gap

    const gridW = cell * cols - gap
    const gridH = cell * rows - gap

    const startX = (width - gridW) / 2 + dotSize / 2
    const startY = (height - gridH) / 2 + dotSize / 2

    const dots: Dot[] = []
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        dots.push({
          cx: startX + x * cell,
          cy: startY + y * cell,
          xOffset: 0,
          yOffset: 0,
          _inertiaApplied: false,
        })
      }
    }
    dotsRef.current = dots
    dirtyRef.current = 2
  }, [dotSize, gap])

  useEffect(() => {
    if (!circlePath) return

    let rafId = 0
    const proxSq = proximity * proximity

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      if (document.visibilityState === 'hidden') return
      // Idle: the last frame is still correct, so leave it on screen.
      if (dirtyRef.current <= 0) return
      dirtyRef.current -= 1

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const { x: px, y: py } = pointerRef.current

      for (const dot of dotsRef.current) {
        const ox = dot.cx + dot.xOffset
        const oy = dot.cy + dot.yOffset
        const dx = dot.cx - px
        const dy = dot.cy - py
        const dsq = dx * dx + dy * dy

        let fill = baseColor
        if (dsq <= proxSq) {
          const t = 1 - Math.sqrt(dsq) / proximity
          const r = Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * t)
          const g = Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * t)
          const b = Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * t)
          fill = `rgb(${r},${g},${b})`
        }

        ctx.save()
        ctx.translate(ox, oy)
        ctx.fillStyle = fill
        ctx.fill(circlePath)
        ctx.restore()
      }
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [proximity, baseColor, activeRgb, baseRgb, circlePath])

  useEffect(() => {
    buildGrid()
    let ro: ResizeObserver | null = null
    // `typeof`, not `'ResizeObserver' in window`: the `in` form narrows
    // `window` to `never` in the else branch under strict TS.
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(buildGrid)
      if (wrapperRef.current) ro.observe(wrapperRef.current)
    } else {
      window.addEventListener('resize', buildGrid)
    }
    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', buildGrid)
    }
  }, [buildGrid])

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    /** Enough frames for the elastic return tween to play out. */
    const keepAwake = () => {
      dirtyRef.current = Math.ceil((returnDuration + 1.5) * 60)
    }

    const shove = (dot: Dot, pushX: number, pushY: number) => {
      dot._inertiaApplied = true
      gsap.killTweensOf(dot)
      gsap.to(dot, {
        inertia: { xOffset: pushX, yOffset: pushY, resistance },
        onUpdate: keepAwake,
        onComplete: () => {
          gsap.to(dot, {
            xOffset: 0,
            yOffset: 0,
            duration: returnDuration,
            ease: 'elastic.out(1,0.75)',
            onUpdate: keepAwake,
          })
          dot._inertiaApplied = false
        },
      })
    }

    const onMove = (e: PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const now = performance.now()
      const pr = pointerRef.current
      const dt = pr.lastTime ? now - pr.lastTime : 16
      const dx = e.clientX - pr.lastX
      const dy = e.clientY - pr.lastY
      let vx = (dx / dt) * 1000
      let vy = (dy / dt) * 1000
      let speed = Math.hypot(vx, vy)
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed
        vx *= scale
        vy *= scale
        speed = maxSpeed
      }
      pr.lastTime = now
      pr.lastX = e.clientX
      pr.lastY = e.clientY
      pr.vx = vx
      pr.vy = vy
      pr.speed = speed

      const rect = canvas.getBoundingClientRect()
      pr.x = e.clientX - rect.left
      pr.y = e.clientY - rect.top
      // The proximity tint follows the pointer, so keep painting while it moves.
      dirtyRef.current = Math.max(dirtyRef.current, 6)

      for (const dot of dotsRef.current) {
        const dist = Math.hypot(dot.cx - pr.x, dot.cy - pr.y)
        if (speed > speedTrigger && dist < proximity && !dot._inertiaApplied) {
          shove(dot, dot.cx - pr.x + vx * 0.005, dot.cy - pr.y + vy * 0.005)
        }
      }
    }

    const onClick = (e: MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      for (const dot of dotsRef.current) {
        const dist = Math.hypot(dot.cx - cx, dot.cy - cy)
        if (dist < shockRadius && !dot._inertiaApplied) {
          const falloff = Math.max(0, 1 - dist / shockRadius)
          shove(dot, (dot.cx - cx) * shockStrength * falloff, (dot.cy - cy) * shockStrength * falloff)
        }
      }
    }

    const throttledMove = throttle(onMove, 50)
    window.addEventListener('pointermove', throttledMove, { passive: true })
    window.addEventListener('click', onClick)

    return () => {
      window.removeEventListener('pointermove', throttledMove)
      window.removeEventListener('click', onClick)
    }
  }, [maxSpeed, speedTrigger, proximity, resistance, returnDuration, shockRadius, shockStrength])

  return (
    <section className={`dot-grid ${className}`} style={style} aria-hidden="true">
      <div ref={wrapperRef} className="dot-grid__wrap">
        <canvas ref={canvasRef} className="dot-grid__canvas" />
      </div>
    </section>
  )
}
