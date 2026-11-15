'use client'

import { useEffect, useRef, useState } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

/* ─────────────────────────────────────────────────────────────
   The hero's light: a Backenly dawn. Fine fibres of light fan up from a
   violet horizon below the fold, cooler on the left and warmer on the right,
   into a dark night sky where the nav sits. The colours are the launch film's
   field (violet, indigo-blue, magenta, a lilac core). It is drawn by one
   fragment shader, written for this page.

   Cost: 1x density at 30 fps, only while on screen and the tab is visible;
   one still frame under reduced motion; held by the hero's pause button; a
   CSS gradient if WebGL is unavailable.
───────────────────────────────────────────────────────────── */

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uGain;
uniform float uSy;
uniform vec3 uBase;
uniform vec2 uPt;

float hash(float n){ return fract(sin(n*127.1)*43758.5453); }
float noise(float x){ float i = floor(x), f = fract(x); float u = f*f*(3.0-2.0*f); return mix(hash(i), hash(i+1.0), u); }
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h2(i), h2(i+vec2(1.0,0.0)), u.x), mix(h2(i+vec2(0.0,1.0)), h2(i+vec2(1.0,1.0)), u.x), u.y); }

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float t = uTime;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  // The pointer, eased: the dawn's source drifts a little toward it and the fan leans with it.
  vec2 d = p - vec2(uPt.x * 0.075 * aspect, uSy - uPt.y * 0.018);
  float r = length(d);
  float a0 = atan(d.x, d.y) - uPt.x * 0.055;
  float a = a0 + 0.10 * r * sign(a0) + 0.012 * sin(t * 0.05);

  float s1 = noise(a * 42.0 + t * 0.020);
  float s2 = noise(a * 130.0 - t * 0.035 + 7.0);
  float s3 = noise(a * 380.0 + t * 0.050 + 13.0);
  float strands = pow(s1, 2.2) * 0.55 + pow(s2, 3.0) * 0.45 + pow(s3, 5.0) * 0.5;
  strands *= 0.6 + 0.4 * n2(vec2(a * 30.0, r * 3.0 - t * 0.06));
  float rays = strands * smoothstep(1.75, 0.35, r) * smoothstep(1.30, 0.35, abs(a0));

  float glow = exp(-pow(r - 0.10, 2.0) * 3.2);
  float core = exp(-r * r * 6.0);
  float sky = exp(-pow(p.y - 0.55, 2.0) * 2.0) * 0.25;

  vec3 lilac   = vec3(0.86, 0.80, 1.00);
  vec3 violet  = vec3(0.55, 0.36, 0.96);
  vec3 magenta = vec3(0.62, 0.20, 0.70);
  vec3 indigo  = vec3(0.20, 0.18, 0.55);
  vec3 blue    = vec3(0.16, 0.26, 0.70);
  vec3 col = mix(violet, lilac, smoothstep(0.75, 0.25, r) * 0.7);
  col = mix(col, magenta, smoothstep(0.35, 0.75, r) * smoothstep(1.05, 0.7, r) * 0.55);
  col = mix(col, indigo, smoothstep(0.75, 1.2, r));
  col = mix(col, blue, smoothstep(0.55, 1.0, abs(p.x) / aspect * 2.0) * smoothstep(0.6, 1.1, r) * 0.6);
  col = mix(col, blue, smoothstep(0.15, 0.9, -a0) * 0.30);
  col = mix(col, magenta, smoothstep(0.15, 0.9, a0) * 0.28);

  float light = glow * 0.85 + core * 0.6 + rays * 0.55 * (0.4 + 0.6 * glow + 0.5 * smoothstep(1.4, 0.4, r)) + sky * 0.25;
  vec3 outc = col * light * uGain;
  outc *= smoothstep(1.02, 0.72, uv.y) * 0.85 + 0.15;   // night at the top, for the nav
  outc *= smoothstep(0.0, 0.16, uv.y);                   // the floor settles into the page
  outc = 1.0 - exp(-outc * 1.3);
  outc = uBase + outc;
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outc += (n - 0.5) * (2.0 / 255.0);
  gl_FragColor = vec4(outc, 1.0);
}`

/** The still frame and the first animated frame show the same moment, so nothing jumps. */
const T0 = 12

export function DawnField({ className = '', paused = false }: { className?: string; paused?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const quiet = useSettledReducedMotion()
  const [failed, setFailed] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const pausedRef = useRef(paused)
  const control = useRef<{ start: () => void; stop: () => void } | null>(null)

  useEffect(() => {
    pausedRef.current = paused
    if (paused) control.current?.stop()
    else control.current?.start()
  }, [paused])

  useEffect(() => {
    const el = canvas.current
    const box = wrap.current
    if (!el || !box) return
    const gl = el.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power' })
    if (!gl) {
      setFailed(true)
      return
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)
      if (!s) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
    }
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      setFailed(true)
      return
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFailed(true)
      return
    }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    gl.uniform1f(gl.getUniformLocation(prog, 'uGain'), 1)
    gl.uniform3f(gl.getUniformLocation(prog, 'uBase'), 8 / 255, 9 / 255, 10 / 255)
    const uSy = gl.getUniformLocation(prog, 'uSy')
    const uPt = gl.getUniformLocation(prog, 'uPt')
    gl.uniform2f(uPt, 0, 0)

    const size = () => {
      const r = box.getBoundingClientRect()
      const dpr = Math.min(1, window.devicePixelRatio || 1)
      const w = Math.max(1, Math.round(r.width * dpr))
      const h = Math.max(1, Math.round(r.height * dpr))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
        gl.viewport(0, 0, w, h)
      }
      gl.uniform2f(uRes, w, h)
      // A phone stacks its words lower down the hero, so its horizon sits lower too:
      // the fan still rises behind them, but its bright core stays under the
      // sentence and the tabs (at -0.12 the sentence fell to 2.9:1).
      gl.uniform1f(uSy, r.width < 640 ? -0.32 : -0.24)
    }
    const draw = (t: number) => {
      gl.uniform1f(uTime, t)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    size()
    draw(T0)
    setDrawn(true)

    const animate = !quiet
    let raf = 0
    let visible = true
    let last = 0
    let clock = T0
    let prev = performance.now()
    // A mouse leans the light toward itself; touch and reduced motion never move it.
    const target = { x: 0, y: 0 }
    const eased = { x: 0, y: 0 }
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      target.x = (e.clientX / window.innerWidth) * 2 - 1
      target.y = Math.min(1, Math.max(-1, (e.clientY / Math.max(1, box.getBoundingClientRect().height)) * 2 - 1))
    }
    const onLeave = () => {
      target.x = 0
      target.y = 0
    }
    if (animate && finePointer) {
      window.addEventListener('pointermove', onMove, { passive: true })
      document.documentElement.addEventListener('pointerleave', onLeave)
    }
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.1, (now - prev) / 1000)
      prev = now
      clock += dt
      const k = 1 - Math.exp(-dt * 2.6)
      eased.x += (target.x - eased.x) * k
      eased.y += (target.y - eased.y) * k
      if (now - last < 33) return
      last = now
      gl.uniform2f(uPt, eased.x, eased.y)
      draw(clock)
    }
    const start = () => {
      if (!animate || raf || !visible || document.hidden || pausedRef.current) return
      prev = performance.now()
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    control.current = { start, stop }
    const ro = new ResizeObserver(() => {
      size()
      draw(clock)
    })
    ro.observe(box)
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible) start()
      else stop()
    })
    io.observe(box)
    const onVis = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVis)
    start()

    return () => {
      stop()
      control.current = null
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      // Free what this run made but keep the context alive: Strict Mode runs effects twice.
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [quiet])

  return (
    <div ref={wrap} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {/* The still light is there from the first paint (it is CSS), so the page never brightens under someone already reading;
          the moving light crossfades over it once its first frame is drawn. */}
      <div
        className="absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_100%,rgba(167,139,250,0.55),rgba(91,33,182,0.25)_45%,transparent_75%)] transition-opacity duration-[400ms] ease-out"
        style={{ opacity: failed || !drawn ? 1 : 0 }}
      />
      {!failed && <canvas ref={canvas} className="absolute inset-0 h-full w-full transition-opacity duration-[400ms] ease-out" style={{ opacity: drawn ? 1 : 0 }} />}
    </div>
  )
}
