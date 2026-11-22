'use client'

/**
 * Strands — the sound-vibration visual on the call screen.
 *
 * Source: react-bits (https://www.reactbits.dev/animations/strands),
 * MIT + Commons Clause, © David Haz. Ported to TypeScript with three changes
 * this demo needs:
 *
 *  1. `driveRef` — per-frame uniform overrides read straight out of a ref inside
 *     the existing render loop. Mic and TTS levels arrive at 60 Hz; routing them
 *     through React state would re-render the tree sixty times a second for a
 *     component whose output never comes from the DOM.
 *  2. Renders nothing while the tab is hidden. This runs on phones, and a
 *     fragment shader looping in a backgrounded tab is a battery complaint.
 *  3. `dpr` is capped. The default renderer picks the device pixel ratio, which
 *     on a modern phone means shading 9× the pixels of a desktop for a blurry
 *     glow nobody can resolve.
 *
 * The glass/refraction pass from the original is kept intact — it is off by
 * default here but costs nothing when unused.
 */

import { Renderer, Program, Mesh, Color, Triangle, RenderTarget } from 'ogl'
import { useEffect, useRef, type RefObject } from 'react'

import './Strands.css'

const MAX_STRANDS = 12
const MAX_COLORS = 8

/** The subset of uniforms worth animating from audio, frame by frame. */
export type StrandsDrive = {
  speed?: number
  amplitude?: number
  waviness?: number
  thickness?: number
  intensity?: number
  glow?: number
  opacity?: number
  hueShift?: number
  scale?: number
  saturation?: number
}

export type StrandsProps = {
  colors?: string[]
  count?: number
  speed?: number
  amplitude?: number
  waviness?: number
  thickness?: number
  glow?: number
  taper?: number
  spread?: number
  hueShift?: number
  intensity?: number
  saturation?: number
  opacity?: number
  scale?: number
  glass?: boolean
  refraction?: number
  dispersion?: number
  glassSize?: number
  /** Read every frame; any value present wins over the matching prop. */
  driveRef?: RefObject<StrandsDrive>
  /** Ceiling on device pixel ratio. 1.5 is indistinguishable from 3 here. */
  maxDpr?: number
  className?: string
  style?: React.CSSProperties
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;
uniform int uStrandCount;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaviness;
uniform float uThickness;
uniform float uGlow;
uniform float uTaper;
uniform float uSpread;
uniform float uHueShift;
uniform float uIntensity;
uniform float uOpacity;
uniform float uScale;
uniform float uSaturation;

out vec4 fragColor;

const float PI = 3.14159265;

vec3 spectrum(float t) {
  return 0.5 + 0.5 * cos(2.0 * PI * (t + vec3(0.00, 0.33, 0.67)));
}

vec3 samplePalette(float t) {
  t = fract(t);
  float scaled = t * float(uColorCount);
  int idx = int(floor(scaled));
  float blend = fract(scaled);
  int nextIdx = idx + 1;
  if (nextIdx >= uColorCount) nextIdx = 0;
  return mix(uColors[idx], uColors[nextIdx], blend);
}

vec3 strandColor(float t) {
  if (uColorCount > 0) return samplePalette(t);
  return spectrum(t);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  uv /= max(uScale, 0.0001);

  float e = 0.06 + uIntensity * 0.94;
  float env = pow(max(cos(uv.x * PI * 1.3), 0.0), uTaper);

  vec3 col = vec3(0.0);

  for (int i = 0; i < ${MAX_STRANDS}; i++) {
    if (i >= uStrandCount) break;

    float fi = float(i);
    float ph = fi * 1.7 * uSpread;
    float freq = (2.0 + fi * 0.35) * uWaviness;
    float spd = 1.4 + fi * 1.2;

    float tt = uTime * uSpeed;
    float w = sin(uv.x * freq + tt * spd + ph) * 0.60
            + sin(uv.x * freq * 1.1 - tt * spd * 0.7 + ph * 1.7) * 0.40;

    float amp = (0.1 + 0.02 * e) * env * uAmplitude;
    float y = w * amp;

    float d = abs(uv.y - y);
    float thick = (0.001 + 0.05 * e) * (0.35 + env) * uThickness;
    float g = thick / (d + thick * 0.45);
    g = g * g;

    float h = fi / float(uStrandCount) + uv.x * 0.30 + uTime * 0.04 + uHueShift;
    col += strandColor(h) * g * env;
  }

  col *= 0.45 + 0.7 * e;
  col = 1.0 - exp(-col * uGlow);

  float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(gray), col, uSaturation), 0.0);

  float lum = max(max(col.r, col.g), col.b);
  float alpha = clamp(lum, 0.0, 1.0) * uOpacity;

  fragColor = vec4(col * uOpacity, alpha);
}
`

const GLASS_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uRadius;
uniform float uRefraction;
uniform float uDispersion;

out vec4 fragColor;

vec2 toUv(vec2 p) {
  return p * (uResolution.y / uResolution) + 0.5;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float d = length(p);
  float r = uRadius;

  float edge = fwidth(d) * 1.5;
  float mask = 1.0 - smoothstep(r - edge, r + edge, d);
  if (mask <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(r * r - d * d, 0.0)) / r;
  float nd = d / r;

  vec2 dir = d > 0.0 ? p / d : vec2(0.0);
  float lens = smoothstep(0.85, 1.0, nd) * pow(nd, 6.0);
  vec2 offset = -dir * lens * uRefraction * 0.15;
  vec2 disp = -dir * lens * uDispersion * 0.012;

  vec3 light;
  light.r = texture(uScene, toUv(p + offset - disp)).r;
  light.g = texture(uScene, toUv(p + offset)).g;
  light.b = texture(uScene, toUv(p + offset + disp)).b;

  float fres = pow(1.0 - z, 3.0);
  vec3 rim = vec3(1.0) * fres * 0.18;

  vec2 lightDir = normalize(vec2(-0.55, 0.6));
  float spec = pow(max(dot(p / max(r, 1e-4), lightDir), 0.0), 6.0);
  spec *= smoothstep(r, r * 0.55, d);

  vec3 emissive = light + rim + vec3(spec) * 0.4;
  float emissiveA = clamp(max(max(emissive.r, emissive.g), emissive.b), 0.0, 1.0);

  float bodyA = 0.05 + fres * 0.05;

  float outA = emissiveA + bodyA * (1.0 - emissiveA);
  vec3 outRGB = emissive;

  outRGB *= mask;
  outA *= mask;

  fragColor = vec4(outRGB, outA);
}
`

function buildPalette(colors: string[] | undefined): number[][] {
  const filled = colors && colors.length ? colors : ['#ffffff']
  const padded: number[][] = []
  for (let i = 0; i < MAX_COLORS; i++) {
    const hex = filled[i] ?? filled[filled.length - 1]
    const c = new Color(hex)
    padded.push([c.r, c.g, c.b])
  }
  return padded
}

export default function Strands({
  colors = ['#FF4242', '#7C3AED', '#06B6D4', '#EAB308'],
  count = 3,
  speed = 0.5,
  amplitude = 1,
  waviness = 1,
  thickness = 0.7,
  glow = 2.6,
  taper = 3,
  spread = 1,
  hueShift = 0,
  intensity = 0.6,
  saturation = 1.5,
  opacity = 1,
  scale = 1.5,
  glass = false,
  refraction = 1,
  dispersion = 1,
  glassSize = 1,
  driveRef,
  maxDpr = 1.5,
  className = '',
  style,
}: StrandsProps) {
  const propsRef = useRef<StrandsProps>({})
  propsRef.current = {
    colors,
    count,
    speed,
    amplitude,
    waviness,
    thickness,
    glow,
    taper,
    spread,
    hueShift,
    intensity,
    saturation,
    opacity,
    scale,
    glass,
    refraction,
    dispersion,
    glassSize,
    driveRef,
  }

  const ctnDom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctn = ctnDom.current
    if (!ctn) return

    const renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      dpr: Math.min(window.devicePixelRatio || 1, maxDpr),
    })
    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.canvas.style.backgroundColor = 'transparent'

    const geometry = new Triangle(gl)
    if (geometry.attributes.uv) {
      delete geometry.attributes.uv
    }

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uColors: { value: buildPalette(colors) },
        uColorCount: { value: Math.min(colors.length, MAX_COLORS) },
        uStrandCount: { value: Math.min(count, MAX_STRANDS) },
        uSpeed: { value: speed },
        uAmplitude: { value: amplitude },
        uWaviness: { value: waviness },
        uThickness: { value: thickness },
        uGlow: { value: glow },
        uTaper: { value: taper },
        uSpread: { value: spread },
        uHueShift: { value: hueShift },
        uIntensity: { value: intensity },
        uOpacity: { value: opacity },
        uScale: { value: scale },
        uSaturation: { value: saturation },
      },
    })

    const mesh = new Mesh(gl, { geometry, program })

    const renderTarget = new RenderTarget(gl, {
      width: ctn.offsetWidth,
      height: ctn.offsetHeight,
    })

    const glassProgram = new Program(gl, {
      vertex: VERT,
      fragment: GLASS_FRAG,
      uniforms: {
        uScene: { value: renderTarget.texture },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uRadius: { value: 0.46 * glassSize },
        uRefraction: { value: refraction },
        uDispersion: { value: dispersion },
      },
    })
    const glassMesh = new Mesh(gl, { geometry, program: glassProgram })

    ctn.appendChild(gl.canvas)

    function resize() {
      const width = ctn!.offsetWidth
      const height = ctn!.offsetHeight
      renderer.setSize(width, height)
      // uResolution has to be the DRAW BUFFER size, not the CSS size: the
      // shaders read gl_FragCoord, which counts device pixels. Upstream passes
      // offsetWidth/offsetHeight and gets away with it because its renderer runs
      // at dpr 1; capping the dpr above makes the two disagree, and the visible
      // symptom is strands drawn off-centre and undersized on any retina screen.
      const bw = gl.drawingBufferWidth
      const bh = gl.drawingBufferHeight
      program.uniforms.uResolution.value = [bw, bh]
      renderTarget.setSize(bw, bh)
      glassProgram.uniforms.uResolution.value = [bw, bh]
    }
    // A ResizeObserver, not just `window.resize`: this canvas lives in a flex
    // child whose height is only known after the rest of the call screen has
    // laid out, and upstream's window-only listener leaves it mis-sized (the
    // strands render off-centre) until something else triggers a resize.
    window.addEventListener('resize', resize)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    ro?.observe(ctn)
    resize()

    let animateId = 0
    const update = (t: number) => {
      animateId = requestAnimationFrame(update)
      // Nothing to look at on a hidden tab; do not shade it.
      if (document.visibilityState === 'hidden') return

      const base = propsRef.current
      const drive = base.driveRef?.current ?? {}
      /** Audio-driven value if the caller is supplying one, else the prop. */
      const u = <K extends keyof StrandsDrive>(key: K, fallback: number): number => {
        const v = drive[key]
        return typeof v === 'number' ? v : fallback
      }

      program.uniforms.uTime.value = t * 0.001
      program.uniforms.uColors.value = buildPalette(base.colors)
      program.uniforms.uColorCount.value = Math.min(base.colors!.length, MAX_COLORS)
      program.uniforms.uStrandCount.value = Math.min(Math.max(Math.round(base.count!), 1), MAX_STRANDS)
      program.uniforms.uSpeed.value = u('speed', base.speed!)
      program.uniforms.uAmplitude.value = u('amplitude', base.amplitude!)
      program.uniforms.uWaviness.value = u('waviness', base.waviness!)
      program.uniforms.uThickness.value = u('thickness', base.thickness!)
      program.uniforms.uGlow.value = u('glow', base.glow!)
      program.uniforms.uTaper.value = base.taper!
      program.uniforms.uSpread.value = base.spread!
      program.uniforms.uHueShift.value = u('hueShift', base.hueShift!)
      program.uniforms.uIntensity.value = u('intensity', base.intensity!)
      program.uniforms.uOpacity.value = u('opacity', base.opacity!)
      program.uniforms.uScale.value = u('scale', base.scale!)
      program.uniforms.uSaturation.value = u('saturation', base.saturation!)

      if (base.glass) {
        renderer.render({ scene: mesh, target: renderTarget })
        glassProgram.uniforms.uScene.value = renderTarget.texture
        glassProgram.uniforms.uRefraction.value = base.refraction
        glassProgram.uniforms.uDispersion.value = base.dispersion
        glassProgram.uniforms.uRadius.value = 0.46 * base.glassSize!
        renderer.render({ scene: glassMesh })
      } else {
        renderer.render({ scene: mesh })
      }
    }
    animateId = requestAnimationFrame(update)

    return () => {
      cancelAnimationFrame(animateId)
      ro?.disconnect()
      window.removeEventListener('resize', resize)
      if (gl.canvas.parentNode === ctn) {
        ctn.removeChild(gl.canvas)
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={ctnDom} className={`strands-container ${className}`} style={style} />
}
