/* ─────────────────────────────────────────────────────────────
   Symbols drawn into the art: lucide glyphs (ISC, already in package.json
   as lucide-react) as raw 24 × 24 path data, so a scene can lay one on a
   table's top face or set one inside a status circle. The chips around the
   art use the same glyphs through lucide-react (../FeatureArt).
───────────────────────────────────────────────────────────── */

import type { Scene } from './iso'

/** lucide path data, 24 × 24, stroke 2. */
export const GLYPH = {
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  key: '<path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  app: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  code: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  bang: '<path d="M12 6v8"/><path d="M12 18h.01"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
} as const

export type GlyphName = keyof typeof GLYPH

/** A glyph laid flat on a top face, its 24-unit box `size` scene units wide, along +x. */
export function topGlyph(sc: Scene, x: number, y: number, z: number, name: GlyphName, size: number, color: string, opacity = 0.8) {
  const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6)
  const k = (size * sc.s) / 24
  const [ex, ey] = sc.P(x, y, z)
  const m = `matrix(${(C * k).toFixed(4)} ${(S * k).toFixed(4)} ${(-C * k).toFixed(4)} ${(S * k).toFixed(4)} ${ex} ${ey})`
  return `<g transform="${m}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${GLYPH[name]}</g>`
}

/**
 * A status circle, upright, as a flowchart draws one: a ring in the role's colour on a dark disc, its glyph
 * inside, and a soft halo that needs no filter. `attrs` goes on the outer group, e.g. a data-a key.
 */
export function statusCircle(ns: string, key: string, cx: number, cy: number, r: number, glyph: GlyphName, color: string, ink: string, attrs = '') {
  const k = (r * 1.12) / 24
  return `<g ${attrs}>
    <radialGradient id="${ns}${key}h"><stop offset="0.45" stop-color="${color}" stop-opacity="0.34"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>
    <circle cx="${cx}" cy="${cy}" r="${r * 2.1}" fill="url(#${ns}${key}h)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}" stroke="${color}" stroke-width="2"/>
    <g transform="translate(${cx - 12 * k} ${cy - 12 * k}) scale(${k})" fill="none" stroke="${color}" stroke-width="${(2.3 / k).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${GLYPH[glyph]}</g>
  </g>`
}
