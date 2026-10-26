/* ─────────────────────────────────────────────────────────────
   The "restructuring" scene: the Architecture Evolution Engine's one
   primitive, structural extraction (lib/structural-evolution), played on
   the same example store as the self-healing scene and drawn in its
   language (./operated-engine): a static isometric camera, matte clay slabs
   under one key light, monochrome with emphasis by brightness, and the brand
   violet only for what Backenly itself does. The canvas is transparent, so
   the BentoCell around it is the surface.

   The story (its timing and narration in ./evolution-story) is the ladder
   in lib/structural-evolution/plan.ts, in the words the console uses
   (lib/structural-evolution/words.ts):

     notice     the refund columns behave as one job of their own, and
                changing them has locked `orders` while it was in use (the
                measured cost that makes a proposal executable)
     rehearse   the whole change, on a copy, rolled back
     approve    nothing runs until a person approves that exact plan
     move       create order_refunds, mirror every write into it, copy the
                existing rows in batches, check both tables match
     open       readable and writable by exactly who could use the parent;
                writes flow both ways, so old and new code both work
     contract   the old columns stay on `orders`: planned, shown, never run
                by software

   Your app's requests never stop: they are the proof that apps keep working.
   The packets queue only once, in the notice beat, to show the cost the
   change removes; nothing Backenly does here stops them.

   Nothing that leaves eases in (emil-design-eng): exits ease out, and the
   copy sinking back and the approval dropping into place ease in and out,
   like anything that travels on screen.

   GSAP sequences the story. One paused timeline, detached from GSAP's own
   ticker, tweens plain numbers; the card's loop sets its time each frame and
   three.js draws from them, so a chapter is a seek and the still frame is
   the same function at one time. Each number has exactly one tween, so any
   seek, forwards or back, lands on the same frame.

   No post-processing: the default framebuffer is antialiased everywhere.
───────────────────────────────────────────────────────────── */

import type * as T from 'three'
import {
  APPROVE_AT,
  APPROVED_AT,
  BACKFILL_AT,
  BACKFILL_D,
  CONTRACT_AT,
  CYCLE,
  LOCK_AT,
  LOCK_END,
  MOVE_AT,
  OPEN_AT,
  REFUNDS,
  REHEARSE_AT,
  REVERSE_AT,
  SYNC_AT,
  VERIFY_AT,
} from './evolution-story'

/** The backfill's batches: one tile per member column each, riding the bus. */
const BATCHES = 6

/* ── The schema ────────────────────────────────────────────────────── */

/* Keys are marked as the console's table view marks them: the parent's own key, and the reference to it. */
const ORDERS_COLS: [string, string][] = [
  ['id', 'uuid pk'],
  ['customer_id', 'uuid fk'],
  ['total', 'numeric'],
  ['status', 'text'],
  ['refund_amount', 'numeric'],
  ['refund_reason', 'text'],
  ['refunded_at', 'timestamptz'],
]
/** The columns leaving `orders`: rows 4, 5 and 6, nearest the viewer. */
const MEMBERS = [4, 5, 6]
const SAT_COLS: [string, string][] = [
  ['id', 'uuid pk'],
  ['order_id', 'uuid fk'],
  ['refund_amount', 'numeric'],
  ['refund_reason', 'text'],
  ['refunded_at', 'timestamptz'],
]
/** Where the members land in order_refunds: its rows 2, 3 and 4. */
const SAT_MEMBERS = [2, 3, 4]

/*
 * One line, left to right, because that is the story: your app → orders ⇄
 * order_refunds ← new code. A wide, shallow board fits the card's wide canvas,
 * so the two tables (the protagonists) are drawn as large as the frame
 * allows; the rest of the store is left out rather than shrunk into a row of
 * blank slabs.
 */
const BOARD = { x0: -5.55, x1: 5.55, z0: -2.05, z1: 2.05, h: 0.14 }
const BT = BOARD.h
const SH = 0.16
const ST = BT + SH
/** Both tables share a width, so a row keeps its size when it is copied across. */
const TW = 3.4
const ROW = 0.36
const HEAD = 0.54
const EDGE = 0.08
const INSET = 0.18
const depthOf = (rows: number) => HEAD + rows * ROW + 2 * EDGE
const OD = depthOf(ORDERS_COLS.length)
const SD = depthOf(SAT_COLS.length)
const ORD = { x: -2.45, z: 0 }
/** order_refunds' back edge sits two rows forward, so each member row lines up with its source. */
const SAT = { x: 2.45, z: -OD / 2 + 2 * ROW + SD / 2 }
const rowZ = (centreZ: number, depth: number, i: number) => centreZ - depth / 2 + EDGE + HEAD + (i + 0.5) * ROW
const ORD_L = ORD.x - TW / 2
const ORD_R = ORD.x + TW / 2
const SAT_L = SAT.x - TW / 2
const SAT_R = SAT.x + TW / 2

/** The pads stand just off the board's ends: the apps are outside the backend. */
const PAD = { w: 1.15, d: 0.8 }
const APP_PAD = { x: BOARD.x0 - 0.2 - PAD.w / 2, z: -0.7 }
const NEW_PAD = { x: BOARD.x1 + 0.2 + PAD.w / 2, z: -0.1 }
const TRACE_Y = BT + 0.012
/** Your app's route: off its pad, straight into the side of `orders`. */
const APP_ROUTE: [number, number][] = [
  [APP_PAD.x + PAD.w / 2, APP_PAD.z],
  [ORD_L, APP_PAD.z],
]
/** New code's route, the mirror image, into the side of order_refunds. */
const NEW_ROUTE: [number, number][] = [
  [NEW_PAD.x - PAD.w / 2, NEW_PAD.z],
  [SAT_R, NEW_PAD.z],
]

/* ── Helpers ───────────────────────────────────────────────────────── */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
const win = (t: number, a: number, b: number, f = 0.3) => smooth(a, a + f, t) * (1 - smooth(b - f, b, t))
const easeInOut = (x: number) => {
  const t = clamp(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

type Route = { segs: { x0: number; z0: number; x1: number; z1: number; len: number }[]; len: number }
function routeOf(points: [number, number][]): Route {
  const segs = points.slice(1).map(([x1, z1], i) => {
    const [x0, z0] = points[i]
    return { x0, z0, x1, z1, len: Math.hypot(x1 - x0, z1 - z0) }
  })
  return { segs, len: segs.reduce((a, s) => a + s.len, 0) }
}
function along(route: Route, d: number, y: number, out: T.Vector3) {
  let rest = clamp(d, 0, route.len)
  for (const s of route.segs) {
    if (rest <= s.len) {
      const f = s.len ? rest / s.len : 0
      return out.set(s.x0 + (s.x1 - s.x0) * f, y, s.z0 + (s.z1 - s.z0) * f)
    }
    rest -= s.len
  }
  const last = route.segs[route.segs.length - 1]
  return out.set(last.x1, y, last.z1)
}

const APP = routeOf(APP_ROUTE)
const NEW = routeOf(NEW_ROUTE)

/* ── Traffic: deterministic in t, so a seek or a still frame shows real positions ── */

const APP_EVERY = 0.42
const APP_SPEED = 1.5
const NEW_EVERY = 0.62
const NEW_SPEED = 1.45
const NEW_FROM = OPEN_AT + 0.75
const QUEUE_GAP = 0.27
/** Where a queued request waits while `orders` is locked: just short of its side. */
const GATE = APP.len - 0.24

/**
 * How far request k has travelled at t, and whether it has arrived. While
 * `orders` is locked (LOCK_AT..LOCK_END) a request that reaches the gate waits
 * there, behind the ones already waiting, and they are let through one after
 * another when the lock ends: the cost the restructuring removes.
 */
function appDistance(k: number, t: number) {
  const s = k * APP_EVERY
  if (t < s) return -1
  const nominal = (t - s) * APP_SPEED
  const atGate = s + GATE / APP_SPEED
  // Requests that reach the gate while it is shut queue in order of arrival.
  if (atGate >= LOCK_AT && atGate < LOCK_END + 0.01) {
    const q = Math.floor((atGate - LOCK_AT) / APP_EVERY)
    const stop = GATE - q * QUEUE_GAP
    const release = LOCK_END + q * 0.16
    const atStop = s + stop / APP_SPEED
    if (t < atStop) return nominal
    if (t < release) return stop
    return stop + (t - release) * APP_SPEED
  }
  return nominal
}
/** When request k reaches `orders` (for the forward sync's pulse). */
function appArrival(k: number) {
  const s = k * APP_EVERY
  const atGate = s + GATE / APP_SPEED
  if (atGate >= LOCK_AT && atGate < LOCK_END + 0.01) {
    const q = Math.floor((atGate - LOCK_AT) / APP_EVERY)
    const stop = GATE - q * QUEUE_GAP
    return LOCK_END + q * 0.16 + (APP.len - stop) / APP_SPEED
  }
  return s + APP.len / APP_SPEED
}

/* ── Shaders (the floor and the scan's wake; the rest is standard material) ── */

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
    // The self-healing scene's dotted ground: a dot every half unit, fading
    // out before the canvas edge, the cell's own surface between the dots.
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
  /** The span inside the backfill chip whose text is the running count. */
  count: () => HTMLElement | null
  pointer: () => { x: number; y: number }
}

export type Engine = {
  render: (t: number, now: number, still?: boolean) => void
  resize: () => void
  dispose: () => void
}

export async function createEngine(canvas: HTMLCanvasElement, wrap: HTMLElement, hooks: EngineHooks): Promise<Engine> {
  const [THREE, { RoundedBoxGeometry }, { gsap }] = await Promise.all([
    import('three'),
    import('three/examples/jsm/geometries/RoundedBoxGeometry.js'),
    import('gsap'),
  ])

  /* ── The story's numbers, sequenced by one GSAP timeline ─────────── */

  const S = {
    fadeIn: 0,
    fadeOut: 0,
    scan1: 0,
    notice: 0,
    lockOn: 0,
    lockOff: 0,
    ghostUp: 0,
    ghostSat: 0,
    ghostScan: 0,
    ghostDown: 0,
    holdIn: 0,
    drop: 0,
    satRise: 0,
    satGlowOff: 0,
    noticeDim: 0,
    copy: 0,
    satRows: 0,
    trace: 0,
    backfill: 0,
    verify: 0,
    openPad: 0,
    openTrace: 0,
    contract: 0,
  }
  type Key = keyof typeof S
  const tl = gsap.timeline({ paused: true, defaults: { immediateRender: false } })
  // Detached from GSAP's global timeline: nothing advances it but the card's own loop.
  gsap.globalTimeline.remove(tl)
  const step = (key: Key, at: number, duration: number, ease = 'power2.out') =>
    tl.fromTo(S, { [key]: 0 }, { [key]: 1, duration, ease }, at)
  step('fadeIn', 0, 0.5, 'power1.out')
  step('scan1', 2.45, 1.1, 'none')
  step('notice', 2.9, 0.7)
  step('lockOn', LOCK_AT, 0.25)
  step('lockOff', LOCK_END, 0.35, 'power2.out')
  step('ghostUp', REHEARSE_AT + 0.1, 0.8, 'power3.out')
  step('ghostSat', REHEARSE_AT + 0.75, 0.6)
  step('ghostScan', REHEARSE_AT + 1.35, 0.85, 'none')
  step('ghostDown', REHEARSE_AT + 2.35, 0.7, 'power2.inOut')
  step('holdIn', APPROVE_AT + 0.1, 0.5, 'power3.out')
  step('drop', APPROVED_AT + 0.4, 0.55, 'power2.inOut')
  step('satRise', MOVE_AT, 1.0, 'expo.out')
  step('noticeDim', MOVE_AT, 0.8, 'power1.inOut')
  step('copy', MOVE_AT + 0.4, 1.5, 'none')
  step('trace', MOVE_AT + 1.6, 0.6)
  step('satRows', MOVE_AT + 1.7, 0.5)
  step('satGlowOff', MOVE_AT + 2.0, 1.4, 'power1.inOut')
  step('backfill', BACKFILL_AT, BACKFILL_D, 'none')
  step('verify', VERIFY_AT, 1.3, 'none')
  step('openPad', OPEN_AT, 0.6, 'power3.out')
  step('openTrace', OPEN_AT + 0.4, 0.5)
  step('contract', CONTRACT_AT, 0.6)
  step('fadeOut', CYCLE - 0.6, 0.6, 'power1.inOut')

  /* ── Renderer, scene, camera ─────────────────────────────────────── */

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' })
  renderer.setClearColor(0x000000, 0)
  // Up to 2x: the printed column names are the scene's content, and at 1.5x they soften on a Retina screen.
  // It draws only while on screen, so the extra pixels cost nothing anywhere else on the page.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80)

  const C = {
    slab: new THREE.Color('#1f2126'),
    board: new THREE.Color('#151619'),
    edge: new THREE.Color('#34363c'),
    row: new THREE.Color('#25272d'),
    /** Every other row, a step lighter: on a slanted table it is the band the eye follows to a row's type. */
    rowAlt: new THREE.Color('#2b2d34'),
    /** A concern row, brought forward by brightness (the bento's emphasis). */
    rowHot: new THREE.Color('#3b3d45'),
    name: new THREE.Color('#a1a1aa'),
    nameHot: new THREE.Color('#fafafa'),
    type: new THREE.Color('#5b5b64'),
    typeHot: new THREE.Color('#a1a1aa'),
    title: new THREE.Color('#d4d4d8'),
    quiet: new THREE.Color('#6b6b74'),
    /** Locked: the brightest edge on the board. */
    hotLine: new THREE.Color('#e4e4e7'),
    /** What Backenly does, and only that: the brand violet. */
    accent: new THREE.Color('#a78bfa'),
    check: new THREE.Color('#c4b5fd'),
    ghost: new THREE.Color('#71717a'),
    white: new THREE.Color('#ffffff'),
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

  /* Floor. */
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
  /** A table nearly as deep as the board casts a tighter, lighter shadow, or the board reads patchy around it. */
  const tableShadowMat = keep(new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: shadowTex, transparent: true, opacity: 0.42, depthWrite: false }))
  /*
   * `spread` is the self-healing scene's for its small slabs; a table here is
   * twice as deep, and the same spread would darken most of the board around
   * it and leave the rest pale.
   */
  const shadow = (w: number, d: number, x: number, y: number, z: number, mat: T.Material = shadowMat, spread = [1.45, 1.75], offset = 0.18) => {
    const geo = keep(new THREE.PlaneGeometry(w * spread[0], d * spread[1]))
    geo.rotateX(-Math.PI / 2)
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x + offset, y + 0.002, z + offset * 0.66)
    m.renderOrder = 1
    scene.add(m)
    return m
  }

  /* Printed type: white glyphs tinted by their material, so a row brightens without a new texture. */
  const monoFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-geist-mono').trim() || 'ui-monospace, monospace'
  try {
    await document.fonts.load(`500 48px ${monoFamily}`)
  } catch {
    /* the fallback face prints instead */
  }
  const textGeo = (text: string, size: number, align: 'left' | 'right') => {
    const px = 64
    const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    probe.font = `500 ${px}px ${monoFamily}`
    const c = document.createElement('canvas')
    c.width = Math.ceil(probe.measureText(text).width) + 8
    c.height = Math.ceil(px * 1.3)
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.font = `500 ${px}px ${monoFamily}`
    g.fillStyle = '#ffffff'
    g.textBaseline = 'middle'
    g.fillText(text, 4, c.height / 2)
    const tex = keep(new THREE.CanvasTexture(c))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const w = (c.width / c.height) * size
    const geo = keep(new THREE.PlaneGeometry(w, size))
    geo.rotateX(-Math.PI / 2)
    geo.translate(align === 'left' ? w / 2 : -w / 2, 0, 0)
    return { geo, tex }
  }
  const printed = (text: string, color: T.Color, size: number, align: 'left' | 'right' = 'left') => {
    const { geo, tex } = textGeo(text, size, align)
    const mat = keep(new THREE.MeshBasicMaterial({ map: tex, color: color.clone(), transparent: true, depthWrite: false }))
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 3
    return { mesh, mat }
  }

  /* The board. */
  const bw = BOARD.x1 - BOARD.x0
  const bd = BOARD.z1 - BOARD.z0
  const bcx = (BOARD.x0 + BOARD.x1) / 2
  const bcz = (BOARD.z0 + BOARD.z1) / 2
  const board = new THREE.Mesh(
    keep(new RoundedBoxGeometry(bw, BOARD.h, bd, 4, 0.08)),
    keep(new THREE.MeshStandardMaterial({ color: C.board, roughness: 0.92, metalness: 0.02 })),
  )
  board.position.set(bcx, BOARD.h / 2, bcz)
  scene.add(board)
  const boardEdge = new THREE.LineSegments(
    keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, BOARD.h, bd))),
    keep(new THREE.LineBasicMaterial({ color: '#25272d' })),
  )
  boardEdge.position.copy(board.position)
  scene.add(boardEdge)
  shadow(bw * 0.82, bd * 0.6, bcx, 0, bcz, boardShadowMat)
  {
    // The self-healing board's name, in the corner this layout leaves free.
    const p = printed('workspace_7f3c · postgres', new THREE.Color('#52525b'), 0.2, 'right')
    p.mesh.position.set(BOARD.x1 - 0.22, BT + 0.003, BOARD.z1 - 0.24)
    scene.add(p.mesh)
  }

  /* A slab: the clay body, its outline and its shadow. */
  type Slab = { group: T.Group; mat: T.MeshStandardMaterial; edgeMat: T.LineBasicMaterial; sh: T.Mesh }
  const slab = (w: number, d: number, x: number, z: number): Slab => {
    const group = new THREE.Group()
    group.position.set(x, BT, z)
    const mat = keep(new THREE.MeshStandardMaterial({ color: C.slab, roughness: 0.82, metalness: 0.04, transparent: true }))
    const body = new THREE.Mesh(keep(new RoundedBoxGeometry(w, SH, d, 4, 0.045)), mat)
    body.position.y = SH / 2
    group.add(body)
    const edgeMat = keep(new THREE.LineBasicMaterial({ color: C.edge.clone(), transparent: true }))
    const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, SH, d))), edgeMat)
    edges.position.y = SH / 2
    group.add(edges)
    scene.add(group)
    const sh = shadow(w, d, x, BT, z, tableShadowMat, [1.16, 1.18], 0.1)
    return { group, mat, edgeMat, sh }
  }

  /* Rows: a strip with the column's name and type printed on it. */
  const stripW = TW - 2 * INSET
  const stripGeo = keep(new THREE.PlaneGeometry(stripW, ROW - 0.04))
  stripGeo.rotateX(-Math.PI / 2)
  type Row = { group: T.Group; base: T.Color; strip: T.MeshBasicMaterial; name: T.MeshBasicMaterial; type: T.MeshBasicMaterial }
  const makeRow = ([col, typ]: [string, string], i: number): Row => {
    const group = new THREE.Group()
    const base = i % 2 ? C.rowAlt : C.row
    const strip = keep(new THREE.MeshBasicMaterial({ color: base.clone(), transparent: true, depthWrite: false }))
    const s = new THREE.Mesh(stripGeo, strip)
    s.renderOrder = 2
    group.add(s)
    const n = printed(col, C.name, 0.2)
    n.mesh.position.set(-stripW / 2 + 0.15, 0.002, 0)
    group.add(n.mesh)
    // The type follows its name, as a schema file reads (`customer_id uuid fk`), not in a column at the
    // table's far edge: seen at this angle a row falls more than its own depth across the table, so a type
    // printed there sits beside the next row's name.
    const nameW = (n.mesh.geometry as T.PlaneGeometry).parameters.width
    const ty = printed(typ, C.type, 0.155)
    ty.mesh.position.set(-stripW / 2 + 0.15 + nameW + 0.1, 0.002, 0.008)
    group.add(ty.mesh)
    return { group, base, strip, name: n.mat, type: ty.mat }
  }
  /** A table: slab, its name in the header band, and its rows, all in one group that can rise from the board. */
  const table = (name: string, cols: [string, string][], x: number, z: number) => {
    const d = depthOf(cols.length)
    const s = slab(TW, d, x, z)
    const title = printed(name, C.title, 0.29)
    title.mesh.position.set(-TW / 2 + 0.26, SH + 0.003, -d / 2 + EDGE + HEAD / 2 + 0.02)
    s.group.add(title.mesh)
    const rows = cols.map((c, i) => {
      const r = makeRow(c, i)
      r.group.position.set(0, SH + 0.003, rowZ(0, d, i))
      s.group.add(r.group)
      return r
    })
    return { ...s, d, title, rows }
  }

  const orders = table('orders', ORDERS_COLS, ORD.x, ORD.z)
  const refunds = table('order_refunds', SAT_COLS, SAT.x, SAT.z)

  /* The old columns' outline: what `contract` would drop, drawn, never run. */
  const memberSpan = MEMBERS.length * ROW
  const memberMidZ = rowZ(ORD.z, OD, MEMBERS[1])
  const oldGeo = keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(stripW + 0.1, 0.001, memberSpan + 0.02)))
  const oldMat = keep(new THREE.LineDashedMaterial({ color: C.ghost, dashSize: 0.1, gapSize: 0.075, transparent: true, opacity: 0 }))
  const oldOutline = new THREE.LineSegments(oldGeo, oldMat)
  oldOutline.computeLineDistances()
  oldOutline.position.set(ORD.x, ST + 0.006, memberMidZ)
  oldOutline.renderOrder = 4
  scene.add(oldOutline)

  /* The copies that carry the member rows across: same strip and type, tinted alike. */
  const copies = MEMBERS.map((m) => {
    const r = makeRow(ORDERS_COLS[m], m)
    r.group.visible = false
    scene.add(r.group)
    return r
  })

  /* Rings that settle on a surface. */
  const ringGeo = keep(new THREE.RingGeometry(0.975, 1.0, 96))
  ringGeo.rotateX(-Math.PI / 2)
  const makeRing = (color: T.Color) => {
    const mat = keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }))
    const mesh = new THREE.Mesh(ringGeo, mat)
    mesh.renderOrder = 5
    scene.add(mesh)
    return { mesh, mat }
  }
  const ringNotice = makeRing(C.accent)
  const ringDrop = makeRing(C.accent)

  /* The scan: a bright line and a faint wake, as in the self-healing scene's check. */
  const makeScan = (depth: number) => {
    const group = new THREE.Group()
    const lineMat = keep(new THREE.MeshBasicMaterial({ color: C.check, transparent: true, depthWrite: false }))
    const lineGeo = keep(new THREE.PlaneGeometry(0.022, depth))
    lineGeo.rotateX(-Math.PI / 2)
    const line = new THREE.Mesh(lineGeo, lineMat)
    line.renderOrder = 6
    group.add(line)
    const wakeMat = keep(
      new THREE.ShaderMaterial({
        vertexShader: WAKE_VS,
        fragmentShader: WAKE_FS,
        uniforms: { uColor: { value: C.check.clone() }, uOpacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
      }),
    )
    const wakeGeo = keep(new THREE.PlaneGeometry(1.2, depth))
    wakeGeo.rotateX(-Math.PI / 2)
    const wake = new THREE.Mesh(wakeGeo, wakeMat)
    wake.position.x = -0.6
    wake.renderOrder = 6
    group.add(wake)
    group.visible = false
    scene.add(group)
    return { group, lineMat, wakeMat }
  }
  const scanTables = makeScan(OD + 0.2)

  /* The rehearsal: a copy of both tables, outlined in dashes, lifted off the board and then rolled back. */
  const GHOST_LIFT = 0.66
  const ghostMat = keep(new THREE.LineDashedMaterial({ color: C.check, dashSize: 0.1, gapSize: 0.07, transparent: true, opacity: 0 }))
  const ghostFillMat = keep(new THREE.MeshBasicMaterial({ color: C.accent, transparent: true, opacity: 0, depthWrite: false }))
  const ghostBox = (w: number, d: number, x: number, z: number) => {
    const group = new THREE.Group()
    const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, SH, d))), ghostMat)
    edges.computeLineDistances()
    group.add(edges)
    const fillGeo = keep(new THREE.PlaneGeometry(w, d))
    fillGeo.rotateX(-Math.PI / 2)
    const fill = new THREE.Mesh(fillGeo, ghostFillMat)
    fill.position.y = SH / 2
    fill.renderOrder = 2
    group.add(fill)
    group.position.set(x, ST + SH / 2, z)
    group.visible = false
    scene.add(group)
    return group
  }
  const ghostOrders = ghostBox(TW, OD, ORD.x, ORD.z)
  const ghostRefunds = ghostBox(TW, SD, SAT.x, SAT.z)
  const scanGhost = makeScan(OD + 0.2)

  /* The approval: a violet marker where Backenly holds the plan for a person. */
  const holdMat = keep(
    new THREE.MeshStandardMaterial({ color: C.accent, emissive: C.accent.clone().multiplyScalar(0.3), roughness: 0.45, transparent: true, opacity: 0 }),
  )
  const holdNode = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.15, 0)), holdMat)
  holdNode.visible = false
  scene.add(holdNode)
  const HOLD_POS = new THREE.Vector3((ORD_R + SAT_L) / 2, ST + 0.88, SAT.z - 0.2)

  /* Traces: the pads' routes and the bus between the two tables. */
  const traceGeo = keep(new THREE.BoxGeometry(1, 0.01, 0.028))
  const traceIdle = keep(new THREE.MeshBasicMaterial({ color: '#2b2d33', transparent: true, depthWrite: false }))
  const traceLit = keep(new THREE.MeshBasicMaterial({ color: '#d4d4d8', transparent: true, opacity: 0.85, depthWrite: false }))
  const busMat = keep(new THREE.MeshBasicMaterial({ color: '#4c4a5c', transparent: true, depthWrite: false }))
  const lay = (x0: number, z0: number, x1: number, z1: number, mat: T.Material, y = TRACE_Y) => {
    const m = new THREE.Mesh(traceGeo, mat)
    m.rotation.y = Math.atan2(-(z1 - z0), x1 - x0)
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2)
    m.scale.x = Math.hypot(x1 - x0, z1 - z0)
    m.renderOrder = 3
    scene.add(m)
    return m
  }
  const layRoute = (r: Route, mat: T.Material) => r.segs.map((s) => lay(s.x0, s.z0, s.x1, s.z1, mat))
  layRoute(APP, traceIdle)
  const newIdle = layRoute(NEW, traceIdle)
  const newLit = layRoute(NEW, traceLit)
  /** The bus: one lane per member column, from its row in `orders` to its row in order_refunds. */
  const lanes = MEMBERS.map((m) => rowZ(ORD.z, OD, m))
  const BUS_X0 = ORD_R
  const BUS_X1 = SAT_L
  const bus = lanes.map((z) => lay(BUS_X0, z, BUS_X1, z, busMat, ST + 0.004))

  /* The pads: your app (always), new code (from the moment order_refunds opens). */
  const padGeo = keep(new RoundedBoxGeometry(PAD.w, BOARD.h, PAD.d, 4, 0.06))
  const padEdgeGeo = keep(new THREE.EdgesGeometry(new THREE.BoxGeometry(PAD.w, BOARD.h, PAD.d)))
  const makePad = (at: { x: number; z: number }) => {
    const group = new THREE.Group()
    group.position.set(at.x, BOARD.h / 2, at.z)
    const mat = keep(new THREE.MeshStandardMaterial({ color: '#1a1b20', roughness: 0.9, transparent: true }))
    group.add(new THREE.Mesh(padGeo, mat))
    const edgeMat = keep(new THREE.LineBasicMaterial({ color: '#2a2c32', transparent: true }))
    group.add(new THREE.LineSegments(padEdgeGeo, edgeMat))
    scene.add(group)
    const sh = shadow(PAD.w, PAD.d, at.x, 0, at.z)
    return { group, mat, edgeMat, sh }
  }
  makePad(APP_PAD)
  const newPad = makePad(NEW_PAD)

  /* Requests (white), and Backenly's own movements between the tables (violet). */
  const MAX_APP = 12
  const MAX_NEW = 8
  const MAX_PULSE = 16
  const TILES = MEMBERS.length * BATCHES
  const packetGeo = keep(new THREE.BoxGeometry(0.12, 0.08, 0.12))
  const packetMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.3 }))
  const pulseMat = keep(new THREE.MeshStandardMaterial({ color: C.check, emissive: C.accent, emissiveIntensity: 0.55, roughness: 0.35 }))
  const tileGeo = keep(new THREE.BoxGeometry(0.15, 0.03, 0.15))
  const instanced = (geo: T.BufferGeometry, mat: T.Material, count: number) => {
    const m = new THREE.InstancedMesh(geo, mat, count)
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    m.renderOrder = 7
    scene.add(m)
    return m
  }
  const appPackets = instanced(packetGeo, packetMat, MAX_APP)
  const newPackets = instanced(packetGeo, packetMat, MAX_NEW)
  const pulses = instanced(packetGeo, pulseMat, MAX_PULSE)
  const tiles = instanced(tileGeo, pulseMat, TILES)

  /* ── Framing: fit the isometric view to the scene's bounds, once per size ── */

  let W = 1
  let H = 1
  let narrow = false
  /*
   * Flatter in azimuth and steeper in elevation than the self-healing scene
   * (0.5, 0.6). Its tables carry one printed name; these carry a column list,
   * which reads better nearer the horizontal and less foreshortened, and a
   * long, shallow board at that scene's azimuth runs corner to corner and
   * leaves half the frame empty.
   */
  const AZ = 0.26
  const EL = 0.84
  const center = new THREE.Vector3(0, 0.3, 0)
  const look = { x: 0, y: 0 }
  const boundsWide = [
    [BOARD.x0, 0, BOARD.z0],
    [BOARD.x1, 0, BOARD.z0],
    [BOARD.x0, 0, BOARD.z1],
    [BOARD.x1, 0, BOARD.z1],
    [APP_PAD.x - PAD.w / 2, 0, APP_PAD.z + PAD.d / 2],
    [NEW_PAD.x + PAD.w / 2, 0, NEW_PAD.z + PAD.d / 2],
    [ORD.x, ST + GHOST_LIFT + 0.12, ORD.z - OD / 2],
    [HOLD_POS.x, HOLD_POS.y + 0.3, HOLD_POS.z],
  ]
  const boundsNarrow = [
    [ORD_L - 0.1, 0, ORD.z - OD / 2],
    [SAT_R + 0.1, 0, SAT.z - SD / 2],
    [ORD_L - 0.1, 0, ORD.z + OD / 2 + 0.1],
    [SAT_R + 0.1, 0, ORD.z + OD / 2 + 0.1],
    [HOLD_POS.x, HOLD_POS.y + 0.3, HOLD_POS.z],
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
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
    let hw = ((x1 - x0) / 2) * (narrow ? 1.04 : 1.07)
    let hh = ((y1 - y0) / 2) * 1.08
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

  /* ── Callouts: DOM chips pinned to scene points ── */

  const pv = new THREE.Vector3()
  function pin(key: string, x: number, y: number, z: number, opacity: number) {
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
  const q = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  const tmp = new THREE.Vector3()
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  let lastCount = -1

  function render(t: number, now: number, still = false) {
    tl.time(clamp(t, 0, CYCLE), true)
    const dip = still ? 1 : S.fadeIn * (1 - S.fadeOut)

    const p = hooks.pointer()
    look.x += (p.x - look.x) * 0.06
    look.y += (p.y - look.y) * 0.06
    if (!still) aim(AZ + look.x * 0.025, EL - look.y * 0.012)

    /* orders: the concern rows brighten when Backenly finds them, and calm once they have a home. */
    const hot = S.notice * (1 - 0.55 * S.noticeDim) * dip
    const locked = S.lockOn * (1 - S.lockOff)
    orders.rows.forEach((r, i) => {
      const j = MEMBERS.indexOf(i)
      // A source row flares as its copy lifts off, so the eye sees where the copy came from.
      const depart = j >= 0 ? clamp((S.copy - j * 0.2) / 0.6) : 0
      const flare = depart > 0 && depart < 0.35 ? Math.sin((depart / 0.35) * Math.PI) : 0
      const h = j >= 0 ? Math.max(hot, flare) : 0
      r.strip.color.copy(r.base).lerp(C.rowHot, h)
      r.name.color.copy(C.name).lerp(C.nameHot, h)
      r.type.color.copy(C.type).lerp(C.typeHot, h)
      r.strip.opacity = dip
      r.name.opacity = dip
      r.type.opacity = dip
    })
    orders.title.mat.opacity = dip
    orders.edgeMat.color.copy(C.edge).lerp(C.hotLine, locked * 0.9)

    /* The rehearsal copy. */
    const ghostOn = S.ghostUp * (1 - S.ghostDown) * dip
    ghostOrders.visible = ghostOn > 0.003
    ghostRefunds.visible = ghostOn > 0.003 && S.ghostSat > 0.003
    if (ghostOrders.visible) {
      const lift = GHOST_LIFT * (S.ghostUp - 0.85 * S.ghostDown)
      ghostOrders.position.y = ST + SH / 2 + lift
      ghostRefunds.position.y = ST + SH / 2 + lift
      ghostRefunds.scale.set(1, Math.max(0.0001, S.ghostSat), 1)
      ghostMat.opacity = 0.85 * ghostOn
      ghostFillMat.opacity = 0.05 * ghostOn
    }
    const gScan = !still && S.ghostScan > 0 && S.ghostScan < 1 ? ghostOn : 0
    scanGhost.group.visible = gScan > 0.003
    if (scanGhost.group.visible) {
      scanGhost.group.position.set(ORD_L + (SAT_R - ORD_L) * S.ghostScan, ghostOrders.position.y + SH / 2 + 0.004, (ORD.z + SAT.z) / 2 - 0.1)
      scanGhost.lineMat.opacity = 0.9 * gScan
      scanGhost.wakeMat.uniforms.uOpacity.value = 0.1 * gScan
    }

    /* The approval marker, then its drop onto the spot order_refunds rises from. */
    const holdF = S.holdIn * (1 - smooth(0.85, 1, S.drop)) * dip
    holdNode.visible = holdF > 0.003
    if (holdNode.visible) {
      const fall = S.drop
      const bob = still ? 0 : Math.sin(now * 0.002) * 0.03 * (1 - fall)
      holdNode.position.set(
        HOLD_POS.x + (SAT.x - HOLD_POS.x) * fall,
        HOLD_POS.y + bob + (BT + 0.2 - HOLD_POS.y) * fall,
        HOLD_POS.z + (SAT.z - HOLD_POS.z) * fall,
      )
      holdNode.rotation.y = still ? 0.4 : now * 0.0012
      holdMat.opacity = holdF
    }

    /* order_refunds rises where the approval landed. */
    const rise = S.satRise
    refunds.group.visible = rise > 0.002
    refunds.sh.visible = rise > 0.3
    if (refunds.group.visible) {
      refunds.group.scale.set(1, Math.max(0.02, rise), 1)
      const glow = rise * (1 - S.satGlowOff)
      refunds.edgeMat.color.copy(C.edge).lerp(C.accent, glow * 0.95)
      refunds.mat.opacity = dip
      refunds.edgeMat.opacity = dip
      refunds.title.mat.opacity = smooth(0.4, 1, rise) * dip
    }
    // Its own rows (id, order_id) appear once it stands; the members arrive as copies.
    const verifyFlash = (x: number) => {
      if (still || S.verify <= 0 || S.verify >= 1) return 0
      const sx = ORD_L - 0.3 + (SAT_R + 0.3 - (ORD_L - 0.3)) * S.verify
      const d = sx - x
      return d >= 0 && d < 0.9 ? 1 - d / 0.9 : 0
    }
    refunds.rows.forEach((r, i) => {
      const member = SAT_MEMBERS.indexOf(i)
      // A member row is there from the moment its copy lands (see the copies below).
      const landed = member >= 0 ? (S.copy >= member * 0.2 + 0.6 ? 1 : 0) : S.satRows
      const backfillPulse = member >= 0 ? backfillGlow(t) : 0
      const flash = verifyFlash(SAT.x - TW / 2 + 0.5)
      r.strip.color.copy(r.base).lerp(C.rowHot, Math.max(backfillPulse * 0.8, flash * 0.6))
      r.name.color.copy(C.name).lerp(C.nameHot, Math.max(backfillPulse * 0.5, flash * 0.5))
      r.type.color.copy(C.type)
      const o = landed * smooth(0.6, 1, rise) * dip
      r.strip.opacity = o
      r.name.opacity = o
      r.type.opacity = o
    })

    /* The copies: each member row lifts off `orders` and lands in its row of order_refunds. */
    copies.forEach((r, j) => {
      // Far enough apart that no two copies overlap in flight.
      const local = clamp((S.copy - j * 0.2) / 0.6)
      const flying = S.copy > 0 && S.copy < 1 && local > 0 && local < 1
      r.group.visible = flying
      if (!flying) return
      const e = easeInOut(local)
      const from = rowZ(ORD.z, OD, MEMBERS[j])
      const to = rowZ(SAT.z, SD, SAT_MEMBERS[j])
      r.group.position.set(ORD.x + (SAT.x - ORD.x) * e, ST + 0.006 + Math.sin(Math.PI * e) * 0.95, from + (to - from) * e)
      const o = smooth(0, 0.08, local) * dip
      r.strip.color.copy(C.rowHot)
      r.name.color.copy(C.nameHot)
      r.type.color.copy(C.typeHot)
      r.strip.opacity = o
      r.name.opacity = o
      r.type.opacity = o
    })

    /* The bus between the tables: drawn once order_refunds stands. */
    bus.forEach((b, i) => {
      const grow = clamp(S.trace * 1.15 - i * 0.075)
      b.visible = grow > 0.002
      if (!b.visible) return
      const len = (BUS_X1 - BUS_X0) * grow
      b.scale.x = Math.max(0.0001, len)
      b.position.x = BUS_X0 + len / 2
    })
    busMat.opacity = dip

    /* The old columns, outlined at the end: kept, and a person's to drop. */
    oldMat.opacity = 0.9 * S.contract * dip
    orders.rows.forEach((r, i) => {
      if (!MEMBERS.includes(i) || S.contract <= 0) return
      r.name.color.lerp(C.quiet, 0.55 * S.contract)
      r.strip.color.lerp(r.base, 0.6 * S.contract)
    })

    /* Backenly's scans: the notice over `orders`, the check over both tables. */
    const sweep = (u: number, x0: number, x1: number) => x0 + (x1 - x0) * u
    let scanOn = 0
    let scanX = 0
    if (!still && S.scan1 > 0 && S.scan1 < 1) {
      scanOn = Math.min(S.scan1 / 0.08, (1 - S.scan1) / 0.08, 1) * dip
      scanX = sweep(S.scan1, ORD_L - 0.25, ORD_R + 0.25)
    } else if (!still && S.verify > 0 && S.verify < 1) {
      scanOn = Math.min(S.verify / 0.06, (1 - S.verify) / 0.06, 1) * dip
      scanX = sweep(S.verify, ORD_L - 0.3, SAT_R + 0.3)
    }
    scanTables.group.visible = scanOn > 0.003
    if (scanTables.group.visible) {
      scanTables.group.position.set(scanX, ST + 0.008, (ORD.z + SAT.z) / 2 - 0.15)
      scanTables.lineMat.opacity = 0.9 * clamp(scanOn)
      scanTables.wakeMat.uniforms.uOpacity.value = 0.09 * clamp(scanOn)
    }
    const fo = verifyFlash(ORD_R - 0.4)
    if (fo > 0) orders.edgeMat.color.lerp(C.check, fo * 0.8)
    const fr = verifyFlash(SAT_R - 0.4)
    if (fr > 0 && refunds.group.visible) refunds.edgeMat.color.lerp(C.check, fr * 0.8)

    /* Rings. */
    const ring = (rg: { mesh: T.Mesh; mat: T.MeshBasicMaterial }, a: number, x: number, y: number, z: number, sx: number, sz: number) => {
      rg.mesh.visible = !still && a > 0 && a < 1
      if (!rg.mesh.visible) return
      const s = 0.55 + 0.4 * (1 - Math.pow(1 - a, 3))
      rg.mesh.position.set(x, y, z)
      rg.mesh.scale.set(s * sx, 1, s * sz)
      rg.mat.opacity = Math.pow(1 - a, 1.5) * dip
    }
    ring(ringNotice, clamp((t - 3.3) / 1.1), ORD.x, ST + 0.008, memberMidZ, TW * 0.62, memberSpan * 0.95)
    ring(ringDrop, clamp((t - (APPROVED_AT + 0.95)) / 1.0), SAT.x, BT + 0.006, SAT.z, TW * 0.62, SD * 0.62)

    /* Your app's requests: they never stop. */
    const kMax = Math.floor(t / APP_EVERY)
    let n = 0
    for (let k = kMax; k >= 0 && n < MAX_APP; k--) {
      const d = appDistance(k, t)
      if (d < 0 || d > APP.len) continue
      along(APP, d, TRACE_Y + 0.05, tmp)
      m4.compose(tmp, q, one)
      appPackets.setMatrixAt(n++, m4)
    }
    for (let i = n; i < MAX_APP; i++) appPackets.setMatrixAt(i, hidden)
    appPackets.instanceMatrix.needsUpdate = true
    appPackets.visible = dip > 0.02

    /* New code's requests, once order_refunds is open. */
    const padUp = S.openPad
    newPad.group.visible = padUp > 0.002
    newPad.sh.visible = padUp > 0.5
    if (newPad.group.visible) {
      newPad.group.position.y = BOARD.h / 2 - 0.5 * (1 - padUp)
      newPad.mat.opacity = padUp * dip
      newPad.edgeMat.opacity = padUp * dip
    }
    newIdle.forEach((m) => (m.visible = padUp > 0.002))
    let walked = 0
    newLit.forEach((m, i) => {
      const s = NEW.segs[i]
      const lit = clamp(S.openTrace * NEW.len - walked, 0, s.len)
      walked += s.len
      m.visible = lit > 0.001 && S.openTrace < 1
      if (!m.visible) return
      const f = lit / s.len
      m.position.set(s.x0 + ((s.x1 - s.x0) * f) / 2, TRACE_Y + 0.001, s.z0 + ((s.z1 - s.z0) * f) / 2)
      m.scale.x = lit
    })
    traceLit.opacity = 0.85 * dip
    n = 0
    if (t >= NEW_FROM) {
      const jMax = Math.floor((t - NEW_FROM) / NEW_EVERY)
      for (let j = jMax; j >= 0 && n < MAX_NEW; j--) {
        const d = (t - NEW_FROM - j * NEW_EVERY) * NEW_SPEED
        if (d < 0 || d > NEW.len) continue
        along(NEW, d, TRACE_Y + 0.05, tmp)
        m4.compose(tmp, q, one)
        newPackets.setMatrixAt(n++, m4)
      }
    }
    for (let i = n; i < MAX_NEW; i++) newPackets.setMatrixAt(i, hidden)
    newPackets.instanceMatrix.needsUpdate = true
    newPackets.visible = dip > 0.02

    /* Backenly keeping the two in step: a pulse per write, orders → order_refunds, and back once writes open. */
    const PULSE_T = 0.55
    n = 0
    const laneZ = lanes[1]
    const pulseAt = (u: number) => {
      if (n >= MAX_PULSE) return
      tmp.set(BUS_X0 + (BUS_X1 - BUS_X0) * u, ST + 0.05, laneZ)
      m4.compose(tmp, q, one)
      pulses.setMatrixAt(n++, m4)
    }
    if (t >= SYNC_AT) {
      for (let k = kMax; k >= 0; k--) {
        const a = appArrival(k)
        if (a > t) continue
        if (a < SYNC_AT) break
        const u = (t - a) / PULSE_T
        if (u > 1) break
        pulseAt(u)
      }
    }
    if (t >= REVERSE_AT) {
      const jMax = Math.floor((t - NEW_FROM) / NEW_EVERY)
      for (let j = jMax; j >= 0; j--) {
        const a = NEW_FROM + j * NEW_EVERY + NEW.len / NEW_SPEED
        if (a > t) continue
        if (a < REVERSE_AT) break
        const u = (t - a) / PULSE_T
        if (u > 1) break
        pulseAt(1 - u)
      }
    }
    for (let i = n; i < MAX_PULSE; i++) pulses.setMatrixAt(i, hidden)
    pulses.instanceMatrix.needsUpdate = true
    pulses.visible = dip > 0.02

    /* The backfill: six batches, one tile per member column, riding the bus. */
    n = 0
    if (S.backfill > 0 && S.backfill < 1) {
      for (let b = 0; b < BATCHES; b++) {
        const u = (S.backfill * BATCHES - b * 0.82) / 1.1
        if (u <= 0 || u >= 1) continue
        lanes.forEach((z) => {
          tmp.set(BUS_X0 + (BUS_X1 - BUS_X0) * easeInOut(u), ST + 0.03, z)
          m4.compose(tmp, q, one)
          tiles.setMatrixAt(n++, m4)
        })
      }
    }
    for (let i = n; i < TILES; i++) tiles.setMatrixAt(i, hidden)
    tiles.instanceMatrix.needsUpdate = true

    renderer.render(scene, camera)

    /* Callouts. */
    const count = Math.round(REFUNDS * smooth(0, 1, S.backfill))
    if (count !== lastCount) {
      lastCount = count
      const el = hooks.count()
      if (el) el.textContent = count.toLocaleString('en-US')
    }
    // On a phone the pads are outside the frame, and so are their labels.
    pin('app', APP_PAD.x, BOARD.h + 0.02, APP_PAD.z, narrow ? 0 : dip)
    pin('concern', ORD_R + 0.04, ST + 0.02, rowZ(ORD.z, OD, MEMBERS[1]), win(t, 3.25, LOCK_END + 0.35, 0.3) * dip)
    pin('lock', ORD_L + 0.45, ST + 0.02, ORD.z - OD / 2 + 0.12, win(t, LOCK_AT + 0.05, LOCK_END + 0.35, 0.25) * dip)
    pin('rehearsal', SAT_R - 0.4, ST + GHOST_LIFT + SH, SAT.z - SD / 2 + 0.06, win(t, REHEARSE_AT + 0.95, REHEARSE_AT + 2.6, 0.3) * dip)
    pin('waits', HOLD_POS.x, HOLD_POS.y + 0.12, HOLD_POS.z, win(t, APPROVE_AT + 0.4, APPROVED_AT + 0.05, 0.25) * dip)
    pin('approved', HOLD_POS.x, HOLD_POS.y + 0.12, HOLD_POS.z, win(t, APPROVED_AT, APPROVED_AT + 0.5, 0.15) * dip)
    pin('satellite', SAT_R - 0.45, ST, SAT.z - SD / 2 + 0.1, win(t, MOVE_AT + 0.9, BACKFILL_AT - 0.1, 0.3) * dip)
    pin('backfill', SAT_R - 0.45, ST, SAT.z - SD / 2 + 0.1, win(t, BACKFILL_AT, VERIFY_AT, 0.25) * dip)
    pin('verified', SAT_R - 0.45, ST, SAT.z - SD / 2 + 0.1, win(t, VERIFY_AT + 0.7, OPEN_AT + 0.3, 0.25) * dip)
    pin('newcode', NEW_PAD.x, BOARD.h + 0.02, NEW_PAD.z, narrow ? 0 : smooth(OPEN_AT + 0.3, OPEN_AT + 0.7, t) * dip)
    const contractOn = smooth(CONTRACT_AT + 0.2, CONTRACT_AT + 0.6, t) * dip
    pin('contract', ORD_R - 0.45, ST, ORD.z + OD / 2 - 0.04, narrow ? 0 : contractOn)
    pin('contract-narrow', ORD.x - 0.6, ST, ORD.z + OD / 2 - 0.04, narrow ? contractOn : 0)

  }

  /** How bright the member rows of order_refunds are as a batch lands (0..1). */
  function backfillGlow(t: number) {
    if (t < BACKFILL_AT || t > BACKFILL_AT + BACKFILL_D + 0.4) return 0
    const u = ((t - BACKFILL_AT) / BACKFILL_D) * BATCHES
    let g = 0
    for (let b = 0; b < BATCHES; b++) {
      const landed = (b * 0.82 + 1.1) / BATCHES
      const dt = u / BATCHES - landed
      if (dt >= 0 && dt < 0.12) g = Math.max(g, 1 - dt / 0.12)
    }
    return g
  }

  function dispose() {
    tl.kill()
    disposables.forEach((d) => d.dispose())
    renderer.dispose()
  }

  // Compile every program now, while the page is idle, including the objects
  // that start hidden, so no shader compiles the first time something appears.
  const hiddenObjects: T.Object3D[] = []
  scene.traverse((o) => {
    if (!o.visible) {
      hiddenObjects.push(o)
      o.visible = true
    }
  })
  await renderer.compileAsync(scene, camera).catch(() => undefined)
  for (const o of hiddenObjects) o.visible = false

  return { render, resize, dispose }
}
