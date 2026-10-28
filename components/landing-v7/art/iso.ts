/* ─────────────────────────────────────────────────────────────
   The isometric kit the two landing illustrations are drawn with
   (./heal-art, ./restructure-art). It returns SVG markup as strings, so a
   scene is drawn once, on the server too, and the card (../FeatureArt)
   animates the groups it marks with `data-a`.

   One projection for everything: x runs right and down, y runs left and
   down, z runs up. A block is three lit faces (the top lightest, the left a
   step darker, the right darkest, as if lit from the top left), a soft
   contact shadow, and its two front top edges catching the light. Every id
   is prefixed with the scene's own namespace, because two scenes share one
   document and SVG ids are document-wide.
───────────────────────────────────────────────────────────── */

const C = Math.cos(Math.PI / 6)
const S = Math.sin(Math.PI / 6)

/** A block colour: [top, left face, right face]. */
export type Hue = readonly [string, string, string]

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
export function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16)
  const f = (c: number) => Math.round(Math.min(255, Math.max(0, amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))))
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')
}

const r1 = (v: number) => Math.round(v * 10) / 10

export interface BoxOptions {
  shadow?: boolean
  shadowOpacity?: number
  edge?: number
  /** Attributes for the block's own group, e.g. a `data-a` key. */
  attrs?: string
}

export function makeScene(ox: number, oy: number, s: number, ns: string) {
  let gid = 0
  const P = (x: number, y: number, z = 0): [number, number] => [r1(ox + (x - y) * C * s), r1(oy + (x + y) * S * s - z * s)]
  const pts = (arr: [number, number, number][]) => arr.map((p) => P(...p).join(',')).join(' ')
  const poly = (arr: [number, number, number][], fill: string, extra = '') => `<polygon points="${pts(arr)}" fill="${fill}" ${extra}/>`

  /** A block: back corner (x, y) on the plane z0, w along x, d along y, h tall. */
  function box(x: number, y: number, z0: number, w: number, d: number, h: number, hue: Hue, o: BoxOptions = {}) {
    const [top, left, right] = hue
    const z1 = z0 + h
    const id = `${ns}b${gid++}`
    let out = `<g ${o.attrs ?? ''}>`
    if (o.shadow !== false) {
      const sh: [number, number, number][] = [[x + 0.15, y + 0.25, z0], [x + w + 0.35, y + 0.25, z0], [x + w + 0.35, y + d + 0.45, z0], [x + 0.15, y + d + 0.45, z0]]
      out += poly(sh, '#000', `opacity="${o.shadowOpacity ?? 0.38}" filter="url(#${ns}blur)"`)
    }
    out += `<linearGradient id="${id}L" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${left}"/><stop offset="1" stop-color="${shade(left, -0.18)}"/></linearGradient>`
    out += `<linearGradient id="${id}R" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${right}"/><stop offset="1" stop-color="${shade(right, -0.22)}"/></linearGradient>`
    out += `<linearGradient id="${id}T" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(top, 0.06)}"/><stop offset="1" stop-color="${top}"/></linearGradient>`
    out += poly([[x, y + d, z0], [x + w, y + d, z0], [x + w, y + d, z1], [x, y + d, z1]], `url(#${id}L)`)
    out += poly([[x + w, y, z0], [x + w, y + d, z0], [x + w, y + d, z1], [x + w, y, z1]], `url(#${id}R)`)
    out += poly([[x, y, z1], [x + w, y, z1], [x + w, y + d, z1], [x, y + d, z1]], `url(#${id}T)`)
    const edge = [P(x, y + d, z1), P(x + w, y + d, z1), P(x + w, y, z1)].map((p) => p.join(',')).join(' ')
    out += `<polyline points="${edge}" fill="none" stroke="#fff" stroke-opacity="${o.edge ?? 0.35}" stroke-width="1.1" stroke-linejoin="round"/>`
    return out + '</g>'
  }

  /** The top face of a block, as one polygon: for tints laid over it. */
  function topFace(x: number, y: number, z: number, w: number, d: number, fill: string, extra = '') {
    return poly([[x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z]], fill, extra)
  }

  /** Text laid on a top face, along +x. */
  function topText(x: number, y: number, z: number, str: string, o: { size?: number; fill?: string; opacity?: number; weight?: number } = {}) {
    const [ex, ey] = P(x, y, z)
    const k = s / 40
    const m = `matrix(${(C * k).toFixed(4)} ${(S * k).toFixed(4)} ${(-C * k).toFixed(4)} ${(S * k).toFixed(4)} ${ex} ${ey})`
    return `<text transform="${m}" font-family="var(--font-geist-mono), 'Geist Mono', ui-monospace, monospace" font-size="${o.size ?? 15}" font-weight="${o.weight ?? 600}" fill="${o.fill ?? '#0b0c14'}" fill-opacity="${o.opacity ?? 0.8}" letter-spacing="-0.01em">${str}</text>`
  }

  /** Thin rules on a top face, like the rows of a table. */
  function rows(x: number, y: number, z: number, w: number, d: number, n: number, color: string, o: { top?: number; gap?: number; len?: number; opacity?: number; width?: number } = {}) {
    let out = ''
    for (let i = 0; i < n; i++) {
      const yy = y + (o.top ?? 0.55) + i * (o.gap ?? 0.28)
      if (yy > y + d - 0.15) break
      const [ax, ay] = P(x + 0.3, yy, z)
      const [bx, by] = P(x + w * (o.len ?? 0.72) - (i % 3) * 0.25, yy, z)
      out += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-opacity="${o.opacity ?? 0.35}" stroke-width="${o.width ?? 2.2}" stroke-linecap="round"/>`
    }
    return out
  }

  /** The screen offset of a move by (dx, dy, dz) in the scene, for a translate. */
  const delta = (dx: number, dy: number, dz = 0): [number, number] => [r1((dx - dy) * C * s), r1((dx + dy) * S * s - dz * s)]

  return { P, pts, poly, box, topFace, topText, rows, delta, s }
}

export type Scene = ReturnType<typeof makeScene>

/** The filters a scene uses, under its own namespace. */
export function sceneDefs(ns: string) {
  return `<defs>
  <filter id="${ns}blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
  <filter id="${ns}glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="12"/></filter>
  <filter id="${ns}glowSm" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>`
}

/** A soft round glow without a filter: a radial gradient, cheap to animate. */
export function glow(ns: string, key: string, cx: number, cy: number, r: number, color: string, opacity: number, attrs = '') {
  return `<radialGradient id="${ns}${key}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${ns}${key})" ${attrs}/>`
}

/**
 * The palette, matched to the rest of the landing (2026-10-28): tables are lit graphite on the page's own
 * near-black, and colour appears only where it means something, as on the hero: Backenly's violet and what it
 * touches, amber for a problem found, green for fixed, rose for a risky request.
 */
export const HUE = {
  graphite: ['#3b3b49', '#2b2b36', '#1f1f28'],
  violet: ['#d6cbff', '#9b7cff', '#6a43e0'],
  rose: ['#ffc1cc', '#fb6f86', '#be123c'],
  slate: ['#2a2a33', '#1f1f27', '#17171d'],
  plinth: ['#1c1c24', '#15151b', '#0f0f14'],
  agent: ['#3b3f52', '#2b2e3d', '#1d1f2a'],
} as const satisfies Record<string, Hue>

/** What is printed on a graphite top (its name, its symbol, its rows): light, as text is on the console. */
export const INK = { label: '#ececf1', glyph: '#b9b9c8', rule: '#a1a1b3' } as const

/** The landing's own violet light (the hero's glow): a pool for a scene to stand in. */
export function lightPool(ns: string, cx: string, cy: string, w: number, h: number) {
  return `<radialGradient id="${ns}bg" cx="${cx}" cy="${cy}" r="60%"><stop offset="0" stop-color="#8b5cf6" stop-opacity="0.16"/><stop offset="0.55" stop-color="#8b5cf6" stop-opacity="0.04"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient><rect width="${w}" height="${h}" fill="url(#${ns}bg)"/>`
}

/** Colours for the states the scenes act out. */
export const ROLE = {
  violet: '#a78bfa',
  violetLine: '#d8ccff',
  gate: '#8b5cf6',
  green: '#34d399',
  greenInk: '#0d3b2c',
  amber: '#fbbf24',
  amberInk: '#3d2e0a',
  rose: '#fb7185',
  /** The visitor's own code, which is neither Backenly's nor a state. */
  neutral: '#d4d4d8',
  ink: '#0b0c14',
} as const
