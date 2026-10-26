/* ─────────────────────────────────────────────────────────────
   The "operated backend" scene, second design (founders, 2026-10-14: "really
   good ... but feels like ai generated slop ... make it professional like a
   real graphics designer designed it").

   What changed from the first cut, and why:
     camera      a static isometric (orthographic) view, the convention of
                 product illustration, instead of a drifting perspective
                 camera, which read as a tech demo
     material    matte clay slabs and columns lit by one key light, instead
                 of additive neon and bloom
     colour      the bento's: monochrome, emphasis by brightness (a slow
                 query is the brightest thing on the board), and the brand
                 violet only for what Backenly itself does (check, fix,
                 hold). The canvas is transparent so the BentoCell around it
                 is the surface (founders: "make it unified").
     structure   one schema board carries the tables; the names are printed
                 on the slabs; the agent sits on its own pad, joined to the
                 board by an orthogonal trace, the way circuit diagrams draw
     labels      callouts with a stem and an anchor dot, one or two at a time

   The story is unchanged: the same minute on a typical backend and on
   Backenly. Safe, additive fixes ship on their own and are re-checked
   (Autopilot is the default level); dropping a table always waits for a
   person. 1,840 ms is the query's mean as pg_stat_statements reports it,
   which is what the slow_query_missing_index probe reads, so the chip holds
   that mean while the bars show single runs around it. After the index the
   bars fall (that is what an index does) but no number is claimed: the
   product verifies by re-running the probe, not by re-measuring latency.

   No post-processing: the default framebuffer is antialiased everywhere,
   including Chrome's D3D11 backend.
───────────────────────────────────────────────────────────── */

import type * as T from 'three'

export type Mode = 'backenly' | 'typical'

/* ── Timeline (seconds into a cycle) ───────────────────────────────── */

export const CYCLE: Record<Mode, number> = { backenly: 14.5, typical: 12.5 }
/** The still frame shown when motion is reduced: the story told, before the fade. */
export const HOLD: Record<Mode, number> = { backenly: 12.8, typical: 11 }

const SLOW_AT = 1.6
const DETECT_AT = 3.2
const FIX_FROM = 3.75
const FIX_AT = 4.4
const VERIFY_AT = 5.4
const AGENT_FROM: Record<Mode, number> = { backenly: 7.0, typical: 6.4 }
const AGENT_TRAVEL = 1.7
const HOLD_AT = AGENT_FROM.backenly + AGENT_TRAVEL
const DROP_AT = AGENT_FROM.typical + AGENT_TRAVEL

export const BEATS: Record<Mode, { at: number; text: string }[]> = {
  backenly: [
    { at: 0, text: 'Backenly runs its checks on your backend every minute.' },
    { at: SLOW_AT, text: 'A query on orders slows to 1,840 ms.' },
    { at: DETECT_AT, text: 'The next check finds the cause: no index on orders.customer_id.' },
    { at: FIX_FROM, text: 'Backenly adds the missing index on its own.' },
    { at: VERIFY_AT, text: 'Then it re-runs the check that found it. Confirmed fixed.' },
    { at: AGENT_FROM.backenly, text: 'Your agent sends DROP TABLE carts.' },
    { at: HOLD_AT - 0.1, text: 'Dropping a table waits for you. All 1,284 rows untouched.' },
  ],
  typical: [
    { at: 0, text: 'A typical backend hosts the same tables.' },
    { at: SLOW_AT, text: 'A query on orders slows to 1,840 ms.' },
    { at: DETECT_AT, text: 'It gets flagged, then waits for someone to fix it.' },
    { at: AGENT_FROM.typical, text: 'Your agent sends DROP TABLE carts.' },
    { at: DROP_AT, text: 'It runs as sent. 1,284 rows gone.' },
  ],
}

export function beatAt(mode: Mode, t: number) {
  let index = 0
  BEATS[mode].forEach((beat, i) => {
    if (t >= beat.at) index = i
  })
  return index
}

/* ── The schema ────────────────────────────────────────────────────── */

export const PLATES = [
  { id: 'users', x: -3.55, z: -1.6 },
  { id: 'products', x: 0, z: -1.6 },
  { id: 'order_items', x: 3.55, z: -1.6 },
  { id: 'orders', x: -1.8, z: 1.25 },
  { id: 'carts', x: 1.8, z: 1.25 },
] as const

const ORDERS = 3
const CARTS = 4
const PW = 2.7
const PD = 1.5
const SH = 0.16
const BOARD = { x0: -5.55, x1: 5.55, z0: -2.7, z1: 2.4, h: 0.14 }
const BT = BOARD.h
const ST = BT + SH
const COLS = 12
const STEP = (PW - 0.6) / COLS
const BAR = 0.115
const BAR_Z = 0.2
const DT = 0.3
const PAD = { x: 4.05, z: 3.65, w: 1.5, d: 0.95 }
const TRACE_Y = BT + 0.012
/** Where the request meets `carts`: its right half, clear of the printed name. */
const APPROACH_X = PLATES[CARTS].x + 0.7
/** The request's route: off the agent's pad, along the front, up to `carts`. */
const ROUTE: [number, number][] = [
  [PAD.x - PAD.w / 2, PAD.z],
  [APPROACH_X, PAD.z],
  [APPROACH_X, PLATES[CARTS].z + PD / 2],
]
const HOLD_Z = PLATES[CARTS].z + PD / 2 + 0.38

/* ── Helpers ───────────────────────────────────────────────────────── */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const win = (t: number, a: number, b: number, f = 0.3) => smooth(a, a + f, t) * (1 - smooth(b - f, b, t))
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3)
const easeInOut = (x: number) => {
  const t = clamp(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function hash(a: number, b: number, c: number) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + 0.5) * 43758.5453
  return s - Math.floor(s)
}

/** Query latency in ms for one table at sample k (time k * DT). */
export function latencyAt(mode: Mode, plate: number, k: number) {
  const s = k * DT
  const n = hash(plate + 1, 2, k)
  let ms = 36 + plate * 4 + n * 24
  if (plate === ORDERS) {
    const slow = smooth(SLOW_AT, SLOW_AT + 0.8, s)
    const fixed = mode === 'backenly' ? smooth(FIX_AT - 0.05, FIX_AT + 0.4, s) : 0
    const peak = 1690 + n * 300
    ms += (peak - ms) * slow * (1 - fixed)
  }
  return ms
}

const barHeight = (ms: number) => 0.1 + 0.98 * Math.pow(clamp((ms - 25) / 1950), 0.7)

/* ── The check: one pass across the board per run ──────────────────────
   Three runs in a cycle, each a single pass: the routine one, the one that
   catches the slow query (it crosses `orders` at DETECT_AT), and the one that
   re-runs it after the fix (crossing at VERIFY_AT). Between runs nothing
   sweeps: the loop is a check every minute, not a scanner that never stops. */

const SCAN_D = 1.6
const SCAN_X0 = BOARD.x0 + 0.1
const SCAN_X1 = BOARD.x1 - 0.1
const scanF = (x: number) => (x - SCAN_X0) / (SCAN_X1 - SCAN_X0)
const PASS_START = [0.2, DETECT_AT - scanF(PLATES[ORDERS].x) * SCAN_D, VERIFY_AT - scanF(PLATES[ORDERS].x) * SCAN_D]
function activePass(t: number) {
  for (const s of PASS_START) if (t >= s && t <= s + SCAN_D) return s
  return null
}
const scanX = (t: number) => {
  const s = activePass(t)
  return s == null ? SCAN_X0 : SCAN_X0 + (SCAN_X1 - SCAN_X0) * ((t - s) / SCAN_D)
}
/** 0..1: a pass fades in at the board's edge and out at the far one. */
function scanAlpha(t: number) {
  const s = activePass(t)
  if (s == null) return 0
  const u = (t - s) / SCAN_D
  return clamp(Math.min(u / 0.08, (1 - u) / 0.08))
}
/** When a pass last crossed x, at or before t (-99 when none has yet). */
function lastPass(t: number, x: number) {
  let best = -99
  for (const s of PASS_START) {
    const c = s + scanF(x) * SCAN_D
    if (c <= t && c > best) best = c
  }
  return best
}

/* ── Shaders (only the floor and the check's wake need custom ones) ── */

const FLOOR_VS = /* glsl */ `
  varying vec2 vXZ;
  varying vec2 vNdc;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vXZ = w.xz;
    gl_Position = projectionMatrix * viewMatrix * w;
    vNdc = gl_Position.xy / gl_Position.w;
  }
`
const FLOOR_FS = /* glsl */ `
  uniform vec3 uDot;
  varying vec2 vXZ;
  varying vec2 vNdc;
  void main() {
    // A dot every half unit, a pixel and a bit across at any size (the bento's
    // dotted line art, laid flat), fading out before the canvas edge so the
    // ground never ends on a line. The canvas is transparent: the cell's own
    // surface shows between the dots.
    vec2 q = vXZ / 0.5;
    vec2 f = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-5));
    float dotA = 1.0 - smoothstep(0.5, 1.3, length(f));
    float fade = 1.0 - smoothstep(0.38, 0.9, length(vNdc));
    gl_FragColor = vec4(uDot, dotA * fade * 0.2);
    #include <colorspace_fragment>
  }
`
const WAKE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const WAKE_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float a = pow(vUv.x, 2.6) * uOpacity;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`

/* ── Engine ────────────────────────────────────────────────────────── */

export type EngineHooks = {
  chip: (key: string) => HTMLElement | null
  progress: () => HTMLElement | null
  pointer: () => { x: number; y: number }
}

export type Engine = {
  render: (mode: Mode, t: number, now: number, still?: boolean) => void
  resize: () => void
  dispose: () => void
}

export async function createEngine(canvas: HTMLCanvasElement, wrap: HTMLElement, hooks: EngineHooks): Promise<Engine> {
  const THREE = await import('three')
  const { RoundedBoxGeometry } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js')

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80)

  const C = {
    slab: new THREE.Color('#1f2126'),
    board: new THREE.Color('#151619'),
    edge: new THREE.Color('#34363c'),
    /** A healthy query: quiet grey. */
    bar: new THREE.Color('#6b6f78'),
    /** A slow query: the brightest thing on the board (emphasis by brightness, as the bento). */
    hot: new THREE.Color('#f4f4f5'),
    hotLine: new THREE.Color('#d4d4d8'),
    /** What Backenly does, and only that: the brand violet. */
    accent: new THREE.Color('#a78bfa'),
    /** The footprint a dropped table leaves. */
    ghost: new THREE.Color('#71717a'),
    white: new THREE.Color('#ffffff'),
    check: new THREE.Color('#c4b5fd'),
  }

  const disposables: { dispose: () => void }[] = []
  const keep = <D extends { dispose: () => void }>(d: D) => {
    disposables.push(d)
    return d
  }

  /* Light: one key from the upper left, a soft fill from the sky. */
  scene.add(new THREE.HemisphereLight('#ffffff', '#16171b', 1.15))
  const key = new THREE.DirectionalLight('#ffffff', 2.1)
  key.position.set(-6, 11, 5)
  scene.add(key)

  /* Floor: a dotted ground that fades out around the board. */
  const floorGeo = keep(new THREE.PlaneGeometry(80, 80))
  floorGeo.rotateX(-Math.PI / 2)
  scene.add(
    new THREE.Mesh(
      floorGeo,
      keep(
        new THREE.ShaderMaterial({
          vertexShader: FLOOR_VS,
          fragmentShader: FLOOR_FS,
          uniforms: { uDot: { value: new THREE.Color('#ffffff') } },
          transparent: true,
          depthWrite: false,
        }),
      ),
    ),
  )

  /* Soft contact shadows, drawn once on a canvas. */
  const shadowTex = (() => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 160
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.filter = 'blur(18px)'
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.roundRect(38, 34, 180, 92, 18)
    g.fill()
    const tex = keep(new THREE.CanvasTexture(c))
    tex.colorSpace = THREE.NoColorSpace
    return tex
  })()
  const shadowMat = keep(new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: shadowTex, transparent: true, opacity: 0.6, depthWrite: false }))
  const boardShadowMat = keep(new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: shadowTex, transparent: true, opacity: 0.32, depthWrite: false }))
  const shadow = (w: number, d: number, x: number, y: number, z: number, mat: T.Material = shadowMat) => {
    const geo = keep(new THREE.PlaneGeometry(w * 1.45, d * 1.75))
    geo.rotateX(-Math.PI / 2)
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x + 0.18, y + 0.002, z + 0.12)
    m.renderOrder = 1
    scene.add(m)
    return m
  }

  /* Printed labels: real type on the surfaces, set in the page's mono face. */
  const monoFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-geist-mono').trim() || 'ui-monospace, monospace'
  try {
    await document.fonts.load(`500 48px ${monoFamily}`)
  } catch {
    /* the fallback face prints instead */
  }
  const printed = (text: string, color: string, x: number, y: number, z: number, size = 0.22) => {
    const px = 64
    const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    probe.font = `500 ${px}px ${monoFamily}`
    const c = document.createElement('canvas')
    c.width = Math.ceil(probe.measureText(text).width) + 8
    c.height = Math.ceil(px * 1.3)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.font = `500 ${px}px ${monoFamily}`
    g.fillStyle = color
    g.textBaseline = 'middle'
    g.fillText(text, 4, c.height / 2)
    const tex = keep(new THREE.CanvasTexture(c))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const h = size
    const w = (c.width / c.height) * h
    const geo = keep(new THREE.PlaneGeometry(w, h))
    geo.rotateX(-Math.PI / 2)
    geo.translate(w / 2, 0, 0)
    const mat = keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(x, y + 0.003, z)
    mesh.renderOrder = 2
    scene.add(mesh)
    return { mesh, mat }
  }

  /* The schema board. */
  const bw = BOARD.x1 - BOARD.x0
  const bd = BOARD.z1 - BOARD.z0
  const bcx = (BOARD.x0 + BOARD.x1) / 2
  const bcz = (BOARD.z0 + BOARD.z1) / 2
  const boardMat = keep(new THREE.MeshStandardMaterial({ color: C.board, roughness: 0.92, metalness: 0.02 }))
  const board = new THREE.Mesh(keep(new RoundedBoxGeometry(bw, BOARD.h, bd, 4, 0.08)), boardMat)
  board.position.set(bcx, BOARD.h / 2, bcz)
  scene.add(board)
  const boardEdge = new THREE.LineSegments(
    keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, BOARD.h, bd))),
    keep(new THREE.LineBasicMaterial({ color: '#25272d' })),
  )
  boardEdge.position.copy(board.position)
  scene.add(boardEdge)
  shadow(bw * 0.82, bd * 0.6, bcx, 0, bcz, boardShadowMat)
  printed('workspace_7f3c · postgres', '#52525b', BOARD.x0 + 0.22, BT, BOARD.z1 - 0.3, 0.2)

  /* Tables. */
  const slabGeo = keep(new RoundedBoxGeometry(PW, SH, PD, 4, 0.045))
  const slabEdgeGeo = keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(PW, SH, PD)))
  const plates = PLATES.map((p) => {
    const mat = keep(new THREE.MeshStandardMaterial({ color: C.slab, roughness: 0.82, metalness: 0.04, transparent: true }))
    const mesh = new THREE.Mesh(slabGeo, mat)
    mesh.position.set(p.x, BT + SH / 2, p.z)
    scene.add(mesh)
    const edgeMat = keep(new THREE.LineBasicMaterial({ color: C.edge.clone(), transparent: true }))
    const edges = new THREE.LineSegments(slabEdgeGeo, edgeMat)
    edges.position.copy(mesh.position)
    scene.add(edges)
    const sh = shadow(PW, PD, p.x, BT, p.z)
    const label = printed(p.id, '#b4b4bc', p.x - PW / 2 + 0.2, ST, p.z - PD / 2 + 0.32, 0.3)
    return { mesh, mat, edges, edgeMat, sh, label }
  })

  /* The empty footprint a dropped table leaves (typical backend only). */
  const ghostGeo = keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(PW, 0.001, PD)))
  const ghostMat = keep(new THREE.LineDashedMaterial({ color: C.ghost, dashSize: 0.12, gapSize: 0.09, transparent: true, opacity: 0 }))
  const ghost = new THREE.LineSegments(ghostGeo, ghostMat)
  ghost.computeLineDistances()
  ghost.position.set(PLATES[CARTS].x, BT + 0.004, PLATES[CARTS].z)
  scene.add(ghost)

  /* Latency columns: matte prisms, one row per table, newest at the right. */
  const COUNT = PLATES.length * COLS
  const barGeo = keep(new RoundedBoxGeometry(BAR, 1, BAR, 2, 0.022))
  barGeo.translate(0, 0.5, 0)
  const barMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.0 }))
  const bars = new THREE.InstancedMesh(barGeo, barMat, COUNT)
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3)
  bars.instanceColor.setUsage(THREE.DynamicDrawUsage)
  bars.frustumCulled = false
  scene.add(bars)

  /* The check: a bright line and a faint wake, both lying on the board. */
  const scan = new THREE.Group()
  const scanLineMat = keep(new THREE.MeshBasicMaterial({ color: C.check, transparent: true, depthWrite: false }))
  const scanLineGeo = keep(new THREE.PlaneGeometry(0.022, bd - 0.24))
  scanLineGeo.rotateX(-Math.PI / 2)
  const scanLine = new THREE.Mesh(scanLineGeo, scanLineMat)
  scanLine.position.set(0, BT + 0.004, bcz)
  scanLine.renderOrder = 3
  scan.add(scanLine)
  const wakeMat = keep(
    new THREE.ShaderMaterial({
      vertexShader: WAKE_VS,
      fragmentShader: WAKE_FS,
      uniforms: { uColor: { value: C.check.clone() }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
    }),
  )
  const wakeGeo = keep(new THREE.PlaneGeometry(1.4, bd - 0.24))
  wakeGeo.rotateX(-Math.PI / 2)
  const wake = new THREE.Mesh(wakeGeo, wakeMat)
  wake.position.set(-0.7, BT + 0.003, bcz)
  wake.renderOrder = 3
  scan.add(wake)
  scene.add(scan)

  /* Rings that settle on a surface: detected (bright), fixed and held (violet), dropped (grey). */
  const ringGeo = keep(new THREE.RingGeometry(0.975, 1.0, 96))
  ringGeo.rotateX(-Math.PI / 2)
  const makeRing = (color: T.Color) => {
    const mat = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }))
    const mesh = new THREE.Mesh(ringGeo, mat)
    mesh.renderOrder = 4
    scene.add(mesh)
    return { mesh, mat }
  }
  const ringDetect = makeRing(C.hotLine)
  const ringFix = makeRing(C.accent)
  const ringHold = makeRing(C.accent)
  const ringDrop = makeRing(C.ghost)

  /* The fix: a pin that lands on `orders`. */
  const PIN_TOP = ST + 1.85
  const pinGeo = keep(new THREE.CylinderGeometry(0.012, 0.012, 1, 10, 1, true))
  pinGeo.translate(0, -0.5, 0)
  const pinMat = keep(new THREE.MeshBasicMaterial({ color: C.accent, transparent: true, opacity: 0, depthWrite: false }))
  const pin = new THREE.Mesh(pinGeo, pinMat)
  pin.position.set(PLATES[ORDERS].x, PIN_TOP, PLATES[ORDERS].z)
  scene.add(pin)
  const headGeo = keep(new THREE.SphereGeometry(0.06, 24, 16))
  const pinHeadMat = keep(
    new THREE.MeshStandardMaterial({ color: C.accent, emissive: C.accent.clone().multiplyScalar(0.35), roughness: 0.4, transparent: true, opacity: 0 }),
  )
  const pinHead = new THREE.Mesh(headGeo, pinHeadMat)
  scene.add(pinHead)

  /* The agent's pad, and the route its request takes. */
  const padMat = keep(new THREE.MeshStandardMaterial({ color: '#1a1b20', roughness: 0.9 }))
  const pad = new THREE.Mesh(keep(new RoundedBoxGeometry(PAD.w, BOARD.h, PAD.d, 4, 0.06)), padMat)
  pad.position.set(PAD.x, BOARD.h / 2, PAD.z)
  scene.add(pad)
  const padEdge = new THREE.LineSegments(
    keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(PAD.w, BOARD.h, PAD.d))),
    keep(new THREE.LineBasicMaterial({ color: '#2a2c32' })),
  )
  padEdge.position.copy(pad.position)
  scene.add(padEdge)
  shadow(PAD.w, PAD.d, PAD.x, 0, PAD.z)
  printed('mcp', '#71717a', PAD.x - PAD.w / 2 + 0.16, BOARD.h, PAD.z + PAD.d / 2 - 0.24, 0.18)

  // The route, as straight runs with real width.
  const segs = ROUTE.slice(1).map(([x1, z1], i) => {
    const [x0, z0] = ROUTE[i]
    return { x0, z0, x1, z1, len: Math.hypot(x1 - x0, z1 - z0) }
  })
  const routeLen = segs.reduce((a, s) => a + s.len, 0)
  const holdDist = routeLen - (HOLD_Z - ROUTE[2][1])
  const traceMat = keep(new THREE.MeshBasicMaterial({ color: '#d4d4d8', transparent: true, opacity: 0.85, depthWrite: false }))
  const traceIdle = keep(new THREE.MeshBasicMaterial({ color: '#2b2d33', depthWrite: false }))
  const traceGeo = keep(new THREE.BoxGeometry(1, 0.01, 0.028))
  const traces = segs.map((s) => {
    const angle = Math.atan2(-(s.z1 - s.z0), s.x1 - s.x0)
    const make = (mat: T.Material) => {
      const m = new THREE.Mesh(traceGeo, mat)
      m.rotation.y = angle
      m.renderOrder = 3
      scene.add(m)
      return m
    }
    const idle = make(traceIdle)
    idle.position.set((s.x0 + s.x1) / 2, TRACE_Y, (s.z0 + s.z1) / 2)
    idle.scale.x = s.len
    const lit = make(traceMat)
    return { s, lit }
  })
  const routePoint = (d: number, out: T.Vector3) => {
    let rest = clamp(d, 0, routeLen)
    for (const s of segs) {
      if (rest <= s.len) {
        const f = rest / s.len
        return out.set(s.x0 + (s.x1 - s.x0) * f, TRACE_Y + 0.05, s.z0 + (s.z1 - s.z0) * f)
      }
      rest -= s.len
    }
    const last = segs[segs.length - 1]
    return out.set(last.x1, TRACE_Y + 0.05, last.z1)
  }
  const packetMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.3 }))
  const packet = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 0.08, 0.12)), packetMat)
  scene.add(packet)

  /* The hold: a violet marker where the request stops. */
  const holdMat = keep(
    new THREE.MeshStandardMaterial({ color: C.accent, emissive: C.accent.clone().multiplyScalar(0.3), roughness: 0.45, transparent: true, opacity: 0 }),
  )
  const holdNode = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.13, 0)), holdMat)
  scene.add(holdNode)

  /* Framing: fit an isometric view to the scene's bounds, once per size. */
  let W = 1
  let H = 1
  let narrow = false
  const AZ = 0.5
  const EL = 0.6
  const center = new THREE.Vector3(0, 0.4, 0.5)
  const look = { x: 0, y: 0 }
  const boundsWide = [
    [BOARD.x0, 0, BOARD.z0],
    [BOARD.x1, 0, BOARD.z0],
    [BOARD.x0, 0, BOARD.z1],
    [BOARD.x1, 0, BOARD.z1],
    [PAD.x + PAD.w / 2, 0, PAD.z + PAD.d / 2],
    [PLATES[ORDERS].x, PIN_TOP + 0.3, PLATES[ORDERS].z],
    [PLATES[0].x, ST + 1.1, PLATES[0].z - PD / 2],
    [PLATES[2].x, ST + 1.1, PLATES[2].z - PD / 2],
  ]
  const boundsNarrow = [
    [-3.9, 0, -0.5],
    [3.4, 0, -0.5],
    [-3.9, 0, BOARD.z1],
    [PAD.x + PAD.w / 2, 0, PAD.z + PAD.d / 2],
    [PLATES[ORDERS].x, PIN_TOP + 0.3, PLATES[ORDERS].z],
  ]
  const aim = (az: number, el: number) => {
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    camera.position.copy(center).addScaledVector(dir, 40)
    camera.up.set(0, 1, 0)
    camera.lookAt(center)
    camera.updateMatrixWorld()
  }
  function resize() {
    W = Math.max(1, wrap.clientWidth)
    H = Math.max(1, wrap.clientHeight)
    narrow = W / H < 1.45
    const pr = Math.min(window.devicePixelRatio || 1, 2)
    renderer.setPixelRatio(pr)
    renderer.setSize(W, H, false)
    aim(AZ, EL)
    const v = new THREE.Vector3()
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const [x, y, z] of narrow ? boundsNarrow : boundsWide) {
      v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
      x0 = Math.min(x0, v.x)
      x1 = Math.max(x1, v.x)
      y0 = Math.min(y0, v.y)
      y1 = Math.max(y1, v.y)
    }
    const aspect = W / H
    let hw = ((x1 - x0) / 2) * 1.06
    let hh = ((y1 - y0) / 2) * 1.1
    if (hw / hh < aspect) hw = hh * aspect
    else hh = hw / aspect
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    camera.left = cx - hw
    camera.right = cx + hw
    camera.top = cy + hh
    camera.bottom = cy - hh
    camera.updateProjectionMatrix()
  }
  resize()

  /* Callouts: DOM labels pinned to scene points. */
  const pv = new THREE.Vector3()
  function pin2(key: string, x: number, y: number, z: number, opacity: number) {
    const el = hooks.chip(key)
    if (!el) return
    if (opacity <= 0.003) {
      if (el.style.opacity !== '0') el.style.opacity = '0'
      return
    }
    pv.set(x, y, z).project(camera)
    const sx = (pv.x * 0.5 + 0.5) * W
    const sy = (-pv.y * 0.5 + 0.5) * H
    el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`
    el.style.opacity = opacity.toFixed(3)
  }

  const m4 = new THREE.Matrix4()
  const col = new THREE.Color()
  const tmp = new THREE.Vector3()

  function render(mode: Mode, t: number, now: number, still = false) {
    const backenly = mode === 'backenly'
    const dip = still ? 1 : smooth(0, 0.45, t) * (1 - smooth(CYCLE[mode] - 0.6, CYCLE[mode], t))

    // The faintest parallax: enough to feel like an object, not a camera move.
    const p = hooks.pointer()
    look.x += (p.x - look.x) * 0.06
    look.y += (p.y - look.y) * 0.06
    if (!still) aim(AZ + look.x * 0.025, EL - look.y * 0.012)

    /* Columns. */
    const kNow = Math.floor(t / DT)
    const frac = t / DT - kNow
    const drop = backenly ? 0 : smooth(DROP_AT, DROP_AT + 0.4, t)
    let idx = 0
    let ordersNow = 0
    for (let pi = 0; pi < PLATES.length; pi++) {
      const plate = PLATES[pi]
      const passAge = backenly ? t - lastPass(t, plate.x) : 99
      for (let i = 0; i < COLS; i++) {
        const k = kNow - (COLS - 1 - i)
        const ms = latencyAt(mode, pi, k)
        if (pi === ORDERS && i === COLS - 1) ordersNow = ms
        let h = barHeight(ms)
        let fade = dip
        if (i === COLS - 1) h *= Math.max(0.0001, smooth(0, 0.5, frac))
        if (i === 0) fade *= 1 - frac
        if (pi === CARTS && drop > 0) fade *= 1 - drop
        h *= Math.max(0.0001, fade)
        const x = plate.x - PW / 2 + 0.3 + (i + 0.5 - frac) * STEP
        // A dropped table's columns go with it, footprint and all.
        const sx = pi === CARTS ? Math.max(0.0001, 1 - drop) : 1
        m4.makeScale(sx, h, sx)
        m4.setPosition(x, ST, plate.z + BAR_Z)
        bars.setMatrixAt(idx, m4)

        const sev = smooth(220, 1100, ms)
        const n = hash(pi + 1, 3, k)
        col.copy(C.bar).multiplyScalar(0.85 + 0.15 * n).lerp(C.hot, sev)
        const sinceFix = k * DT - FIX_AT
        if (backenly && pi === ORDERS && sinceFix > 0 && sinceFix < 2.2) col.lerp(C.accent, 0.85 * (1 - sinceFix / 2.2))
        if (i >= COLS - 2 && passAge >= 0 && passAge < 0.45) col.lerp(C.white, (1 - passAge / 0.45) * 0.7)
        bars.setColorAt(idx, col)
        idx++
      }
    }
    bars.instanceMatrix.needsUpdate = true
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true

    /* Slab outlines carry the table's state. */
    const ordersSev = smooth(220, 1100, ordersNow)
    const fixedGlow = backenly ? smooth(FIX_AT, FIX_AT + 0.2, t) * (1 - smooth(VERIFY_AT + 1.6, VERIFY_AT + 2.8, t)) : 0
    const holdF = backenly ? smooth(HOLD_AT - 0.15, HOLD_AT + 0.25, t) * dip : 0
    plates.forEach((pl, pi) => {
      pl.edgeMat.color.copy(C.edge)
      if (pi === ORDERS) {
        pl.edgeMat.color.lerp(C.hotLine, ordersSev * 0.85 * dip)
        pl.edgeMat.color.lerp(C.accent, fixedGlow * 0.9)
      }
      if (pi === CARTS) {
        pl.edgeMat.color.lerp(C.accent, holdF * 0.85)
        const keepY = Math.max(0.02, 1 - drop)
        pl.mesh.scale.y = keepY
        pl.mesh.position.y = BT + (SH * keepY) / 2
        pl.edges.scale.y = keepY
        pl.edges.position.y = pl.mesh.position.y
        pl.mat.opacity = 1 - drop * 0.9
        pl.edgeMat.opacity = 1 - drop
        pl.label.mat.opacity = 1 - drop
        pl.label.mesh.position.y = BT + SH * keepY + 0.003
        pl.sh.visible = drop < 0.95
      }
    })
    ghostMat.opacity = drop * 0.9

    /* The check. */
    const scanOn = backenly && !still ? dip * scanAlpha(t) : 0
    scan.visible = scanOn > 0.002
    if (scan.visible) {
      scan.position.x = scanX(t)
      scanLineMat.opacity = 0.9 * scanOn
      wakeMat.uniforms.uOpacity.value = 0.09 * scanOn
    }

    /* Rings. */
    const ring = (
      rg: { mesh: T.Mesh; mat: T.MeshBasicMaterial },
      at: number,
      dur: number,
      from: number,
      to: number,
      on: boolean,
      x: number,
      y: number,
      z: number,
      sx: number,
      sz: number,
    ) => {
      const a = (t - at) / dur
      rg.mesh.visible = on && !still && a >= 0 && a <= 1
      if (!rg.mesh.visible) return
      const s = from + (to - from) * easeOut(a)
      rg.mesh.position.set(x, y, z)
      rg.mesh.scale.set(s * sx, 1, s * sz)
      rg.mat.opacity = Math.pow(1 - a, 1.5) * dip
    }
    const O = PLATES[ORDERS]
    const K = PLATES[CARTS]
    ring(ringDetect, DETECT_AT, 1.0, 0.55, 0.95, true, O.x, ST + 0.004, O.z, PW * 0.62, PD * 0.62)
    ring(ringFix, FIX_AT, 1.1, 0.5, 0.95, backenly, O.x, ST + 0.004, O.z, PW * 0.62, PD * 0.62)
    ring(ringHold, HOLD_AT, 1.2, 0.15, 0.7, backenly, APPROACH_X, TRACE_Y, HOLD_Z, 1, 1)
    ring(ringDrop, DROP_AT, 1.0, 0.5, 1.1, !backenly, K.x, BT + 0.004, K.z, PW * 0.62, PD * 0.62)

    /* The fix pin. */
    const pinF = backenly ? win(t, FIX_FROM, VERIFY_AT + 0.4, 0.25) * dip : 0
    pin.visible = pinF > 0.003
    pinHead.visible = pin.visible
    if (pin.visible) {
      const fall = easeInOut((t - FIX_FROM) / (FIX_AT - FIX_FROM))
      const len = (PIN_TOP - ST) * fall
      pin.scale.y = Math.max(0.0001, len)
      pinMat.opacity = 0.85 * pinF
      pinHead.position.set(O.x, PIN_TOP - len, O.z)
      pinHeadMat.opacity = pinF
    }

    /* The request. */
    const a0 = AGENT_FROM[mode]
    const travel = easeInOut((t - a0) / AGENT_TRAVEL)
    const sending = t >= a0
    const endDist = backenly ? holdDist : routeLen
    const dist = sending ? travel * endDist : 0
    const reqVis = sending && (backenly || t < DROP_AT + 0.05) ? dip : 0
    let walked = 0
    for (const tr of traces) {
      const lit = clamp(dist - walked, 0, tr.s.len)
      walked += tr.s.len
      tr.lit.visible = reqVis > 0.003 && lit > 0.001
      if (!tr.lit.visible) continue
      const f = lit / tr.s.len
      tr.lit.position.set(tr.s.x0 + ((tr.s.x1 - tr.s.x0) * f) / 2, TRACE_Y + 0.001, tr.s.z0 + ((tr.s.z1 - tr.s.z0) * f) / 2)
      tr.lit.scale.x = lit
    }
    traceMat.opacity = 0.85 * reqVis
    packet.visible = reqVis > 0.003
    if (packet.visible) {
      routePoint(dist, packet.position)
      const arrived = backenly && t >= HOLD_AT
      packet.scale.setScalar(arrived ? 1 + 0.12 * Math.sin((t - HOLD_AT) * 6) : 1)
    }

    holdNode.visible = holdF > 0.003
    if (holdNode.visible) {
      holdNode.position.set(APPROACH_X, TRACE_Y + 0.42 + (still ? 0 : Math.sin(now * 0.002) * 0.03), HOLD_Z)
      holdNode.rotation.y = still ? 0.4 : now * 0.0012
      holdMat.opacity = holdF
    }

    renderer.render(scene, camera)

    /* Callouts. */
    pin2('scan', scanX(t), BT, BOARD.z0 + 0.15, scanOn > 0 && !narrow ? scanOn : 0)
    const slowChip = backenly ? win(t, SLOW_AT + 0.45, FIX_FROM + 0.1) : smooth(SLOW_AT + 0.45, SLOW_AT + 0.75, t)
    pin2('latency', O.x + PW / 2 - 0.7, ST + barHeight(ordersNow) + 0.05, O.z + BAR_Z, slowChip * dip)
    pin2('detected', O.x - PW / 2 + 0.45, ST + 0.55, O.z - PD / 2 + 0.25, backenly && !narrow ? win(t, DETECT_AT, FIX_FROM + 0.1, 0.2) * dip : 0)
    pin2('flagged', O.x - PW / 2 + 0.45, ST + 0.55, O.z - PD / 2 + 0.25, backenly || narrow ? 0 : smooth(DETECT_AT, DETECT_AT + 0.3, t) * dip)
    pin2('fix', O.x, PIN_TOP + 0.04, O.z, backenly && !narrow ? win(t, FIX_FROM, VERIFY_AT + 0.1, 0.25) * dip : 0)
    pin2('verified', O.x + 1.12, ST + 0.3, O.z + BAR_Z, backenly ? smooth(VERIFY_AT, VERIFY_AT + 0.3, t) * dip : 0)
    pin2('agent', PAD.x, BOARD.h + 0.02, PAD.z, dip)
    if (packet.visible) {
      routePoint(dist, tmp)
      const arrivedB = backenly && t >= HOLD_AT
      pin2('packet', tmp.x, tmp.y + 0.05, tmp.z, arrivedB ? 0 : reqVis)
    } else pin2('packet', 0, 0, 0, 0)
    pin2('waits', APPROACH_X, TRACE_Y + 0.6, HOLD_Z, backenly ? smooth(HOLD_AT, HOLD_AT + 0.3, t) * dip : 0)
    pin2('dropped', K.x, BT + 0.02, K.z, backenly ? 0 : smooth(DROP_AT + 0.15, DROP_AT + 0.45, t) * dip)

    const pr = hooks.progress()
    if (pr) pr.style.transform = `scaleX(${clamp(t / CYCLE[mode]).toFixed(4)})`
  }

  function dispose() {
    disposables.forEach((d) => d.dispose())
    renderer.dispose()
  }

  // Compile every program now, while the page is idle, through
  // KHR_parallel_shader_compile where the driver has it: including the objects
  // that start hidden, so no shader compiles the first time something appears
  // mid-scroll (ANGLE's D3D11 translation can stall a frame for 100 ms+).
  const hidden: T.Object3D[] = []
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o)
      o.visible = true
    }
  })
  await renderer.compileAsync(scene, camera).catch(() => undefined)
  for (const o of hidden) o.visible = false

  return { render, resize, dispose }
}
