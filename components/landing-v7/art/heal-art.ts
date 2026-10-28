/* ─────────────────────────────────────────────────────────────
   "Your backend repairs itself", drawn (2026-10-28): an isometric store
   backend in lit graphite, standing in the page's violet light.

     Check    Backenly's violet sheet of light crosses every table
     Find     orders lights amber: a query on it is slow
     Fix      a violet spark leaves Backenly and sets an index tab on orders
     Verify   the sheet passes again and the green check lands
     Hold     your agent's red DROP package rolls in and stops at the violet
              gate in front of carts, which waits for you

   The tables carry their own symbols (an auth key on users, a package on
   products, a receipt on orders, a cart on carts), as a flowchart labels
   its nodes. The claims are the section's own: checks every minute, fixes
   what is safe on its own (an additive index on Autopilot), holds a
   destructive change (DESTRUCTIVE_TOOLS, lib/ai/brain/tools.ts) for a
   person, with the table's rows untouched while it waits.
───────────────────────────────────────────────────────────── */

import { makeScene, sceneDefs, glow, lightPool, HUE, INK, ROLE } from './iso'
import { topGlyph, statusCircle, type GlyphName } from './symbols'
import { EASE, type Art, type Track } from './types'

const W = 1200, H = 560

export function healArt(ns: string): Art {
  const sc = makeScene(480, 148, 35, ns)
  const { P, poly, box, topFace, topText, rows, delta } = sc
  const a = (key: string) => `data-a="${key}"`
  let b = ''

  b += sceneDefs(ns)
  b += lightPool(ns, '44%', '53%', W, H)

  // The backend: one plinth, five tables.
  b += box(0, 0, -0.6, 10.2, 7.0, 0.6, HUE.plinth, { edge: 0.2, shadowOpacity: 0.6 })

  // Backenly's check: a band of violet light that crosses the plinth, under the tables.
  const band = (y0: number, y1: number, fill: string, op: number) => poly([[0, y0, 0], [10.2, y0, 0], [10.2, y1, 0], [0, y1, 0]], fill, `opacity="${op}"`)
  b += `<g ${a('scan')}>${`<g filter="url(#${ns}glowSm)">${band(-0.32, 0.32, '#a78bfa', 0.55)}</g>`}${band(-0.07, 0.07, '#ede9fe', 0.95)}</g>`

  const T: { n: string; x: number; y: number; w: number; d: number; h: number; glyph: GlyphName }[] = [
    { n: 'users', x: 0.7, y: 0.7, w: 2.5, d: 1.9, h: 0.55, glyph: 'key' },
    { n: 'products', x: 3.85, y: 0.7, w: 2.5, d: 1.9, h: 0.55, glyph: 'package' },
    { n: 'order_items', x: 7.0, y: 0.7, w: 2.5, d: 1.9, h: 0.55, glyph: 'list' },
    { n: 'orders', x: 0.7, y: 3.75, w: 3.9, d: 2.5, h: 0.75, glyph: 'receipt' },
    { n: 'carts', x: 5.6, y: 3.75, w: 3.9, d: 2.5, h: 0.75, glyph: 'cart' },
  ]
  for (const t of T) {
    b += box(t.x, t.y, 0, t.w, t.d, t.h, HUE.graphite, { edge: 0.22 })
    b += topGlyph(sc, t.x + 0.28, t.y + 0.26, t.h, t.glyph, 0.42, INK.glyph, 0.85)
    b += topText(t.x + 0.82, t.y + 0.6, t.h, t.n, { size: t.n.length > 8 ? 12.5 : 14, fill: INK.label, opacity: 0.86, weight: 500 })
    b += rows(t.x, t.y + 0.35, t.h, t.w, t.d - 0.35, 5, INK.rule, { top: 0.62, gap: 0.3, opacity: 0.16 })
    // The check passing over it, as a violet wash on its top.
    b += topFace(t.x, t.y, t.h, t.w, t.d, '#c4b5fd', `opacity="0" ${a(`tint-${t.n}`)}`)
  }

  // orders: what the check finds (amber), and the index Backenly adds on its own (violet).
  const O = T[3]
  b += `<g ${a('amber')} opacity="0">${topFace(O.x, O.y, O.h, O.w, O.d, ROLE.amber, 'opacity="0.26"')}<polyline points="${[P(O.x, O.y + O.d, O.h), P(O.x + O.w, O.y + O.d, O.h), P(O.x + O.w, O.y, O.h)].map((p) => p.join(',')).join(' ')}" fill="none" stroke="${ROLE.amber}" stroke-width="2"/></g>`
  const [bangX, bangY] = P(O.x + 1.7, O.y + 1.25, O.h)
  b += statusCircle(ns, 'bang', bangX, bangY - 44, 13, 'bang', ROLE.amber, ROLE.amberInk, `${a('bang')} opacity="0"`)
  b += box(3.6, 4.05, 0.75, 0.7, 1.5, 0.3, HUE.violet, { shadowOpacity: 0.3, edge: 0.6, attrs: a('tab') })
  const [ix, iy] = P(3.95, 4.8, 1.05)
  b += glow(ns, 'tabG', ix, iy, 46, '#a78bfa', 0.55, `${a('tab-glow')}`)
  b += statusCircle(ns, 'chk', ix, iy - 30, 13, 'check', ROLE.green, ROLE.greenInk, a('check'))

  // carts: Backenly's gate on its open side, and the lock that holds the request.
  const gx = 9.82
  const gate: [number, number, number][] = [[gx, 3.75, 0], [gx, 6.25, 0], [gx, 6.25, 1.65], [gx, 3.75, 1.65]]
  b += `<linearGradient id="${ns}gate" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${ROLE.gate}" stop-opacity="0.55"/><stop offset="1" stop-color="${ROLE.gate}" stop-opacity="0.12"/></linearGradient>`
  b += `<g ${a('gate')}>${poly(gate, `url(#${ns}gate)`)}<polyline points="${[P(gx, 3.75, 1.65), P(gx, 6.25, 1.65)].map((p) => p.join(',')).join(' ')}" fill="none" stroke="${ROLE.violetLine}" stroke-width="2.2"/><polyline points="${[P(gx, 3.75, 0), P(gx, 3.75, 1.65)].map((p) => p.join(',')).join(' ')}" fill="none" stroke="${ROLE.violetLine}" stroke-opacity="0.7" stroke-width="1.4"/></g>`
  const [lx, ly] = P(gx, 5.0, 0.95)

  // The agent's request on the bridge (a red package), and the agent on its own pad.
  b += box(10.2, 4.6, -0.25, 2.4, 0.8, 0.25, HUE.slate, { edge: 0.12, shadowOpacity: 0.3 })
  b += box(10.45, 4.6, 0, 0.8, 0.8, 0.8, HUE.rose, { edge: 0.5, shadowOpacity: 0.45, attrs: a('pkg') })
  b += statusCircle(ns, 'lock', lx, ly, 15, 'lock', ROLE.violetLine, '#241a45', a('lock'))
  b += box(12.6, 3.85, -0.6, 2.6, 2.3, 0.6, HUE.plinth, { edge: 0.18, shadowOpacity: 0.5 })
  b += box(12.95, 4.15, 0, 1.9, 1.7, 0.95, HUE.agent, { edge: 0.25 })
  b += topGlyph(sc, 13.35, 4.55, 0.95, 'terminal', 0.95, '#eef0f6', 0.9)
  const [agx, agy] = P(13.9, 5.0, 0.95)
  b += glow(ns, 'agG', agx, agy, 60, '#fb7185', 0.4, `${a('agent-glow')} opacity="0"`)

  // Backenly, beside the plinth: the light the check comes from.
  b += box(-4.1, 2.9, -0.45, 1.9, 1.9, 0.45, HUE.plinth, { edge: 0.18, shadowOpacity: 0.45 })
  b += box(-3.8, 3.2, 0, 1.3, 1.3, 1.3, HUE.violet, { edge: 0.55 })
  const [bx, by] = P(-3.15, 3.85, 1.3)
  b += glow(ns, 'bkG', bx, by, 62, '#a78bfa', 0.55, a('beacon'))
  {
    const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6)
    const [ex, ey] = P(-3.55, 3.4, 1.3)
    const k = 0.036 * 35
    b += `<g transform="matrix(${(C * k).toFixed(4)} ${(S * k).toFixed(4)} ${(-C * k).toFixed(4)} ${(S * k).toFixed(4)} ${ex} ${ey})"><rect x="0" y="0" width="24" height="4.8" rx="1.8" fill="#fff"/><rect x="0" y="8.6" width="24" height="4.8" rx="1.8" fill="#ede9fe"/><rect x="0" y="17.2" width="24" height="4.8" rx="1.8" fill="#ddd6fe"/></g>`
  }

  // The spark: Backenly's fix, travelling from its light to orders.
  b += `<g ${a('spark')} opacity="0"><circle cx="${bx}" cy="${by}" r="16" fill="url(#${ns}bkG)"/><circle cx="${bx}" cy="${by}" r="4.5" fill="#f5f3ff"/></g>`

  // The open space left of orders, where its chips sit.
  const [ofx, ofy] = P(O.x, O.y + O.d, 0.4)
  const [fx, fy] = [ofx - 26, ofy + 8]

  /* ── Choreography (seconds of a 12 s loop) ──────────────────────────── */
  const cycle = 12
  const tracks: Track[] = []
  // The sheet of light: two passes, the second a re-check.
  const [bdx, bdy] = delta(0, 1)
  const at = (yy: number) => ({ x: bdx * yy, y: bdy * yy })
  tracks.push({
    key: 'scan',
    keys: [
      { t: 0, o: 0, ...at(-0.6) },
      { t: 0.3, o: 0, ...at(-0.6), ease: EASE.inOut },
      { t: 0.45, o: 1, ...at(0.3), ease: EASE.linear },
      { t: 1.45, o: 1, ...at(6.7), ease: EASE.linear },
      { t: 1.6, o: 0, ...at(7.6) },
      { t: 5.2, o: 0, ...at(-0.6), ease: EASE.inOut },
      { t: 5.3, o: 1, ...at(0.3), ease: EASE.linear },
      { t: 5.95, o: 1, ...at(6.7), ease: EASE.linear },
      { t: 6.05, o: 0, ...at(7.6) },
    ],
  })
  // Each table lights as the sheet crosses it.
  const cross = (yc: number, t0: number, t1: number, y0: number, y1: number) => t0 + ((yc - y0) / (y1 - y0)) * (t1 - t0)
  for (const t of T) {
    const yc = t.y + t.d / 2
    const p1 = cross(yc, 0.45, 1.45, 0.3, 6.7)
    const p2 = cross(yc, 5.3, 5.95, 0.3, 6.7)
    tracks.push({
      key: `tint-${t.n}`,
      keys: [
        { t: 0, o: 0 },
        { t: p1 - 0.2, o: 0, ease: EASE.out },
        { t: p1, o: 0.34, ease: EASE.inOut },
        { t: p1 + 0.35, o: 0 },
        { t: p2 - 0.15, o: 0, ease: EASE.out },
        { t: p2, o: t.n === 'orders' ? 0.42 : 0.22, ease: EASE.inOut },
        { t: p2 + 0.3, o: 0 },
      ],
    })
  }
  tracks.push({ key: 'beacon', keys: [{ t: 0, o: 0.55 }, { t: 0.15, o: 0.55, ease: EASE.out }, { t: 0.4, o: 1, ease: EASE.inOut }, { t: 1.2, o: 0.55 }, { t: 5.0, o: 0.55, ease: EASE.out }, { t: 5.25, o: 1, ease: EASE.inOut }, { t: 5.9, o: 0.55 }] })
  // Find: orders turns amber.
  tracks.push({ key: 'amber', keys: [{ t: 0, o: 0 }, { t: 1.6, o: 0, ease: EASE.out }, { t: 1.95, o: 1 }, { t: 4.1, o: 1, ease: EASE.inOut }, { t: 4.45, o: 0 }] })
  tracks.push({ key: 'bang', origin: '50% 50%', keys: [{ t: 0, o: 0, s: 0.6 }, { t: 1.75, o: 0, s: 0.6, ease: EASE.land }, { t: 2.05, o: 1, s: 1 }, { t: 4.05, o: 1, s: 1, ease: EASE.in }, { t: 4.3, o: 0, s: 0.7 }] })
  // Fix: the spark travels in an arc; the tab lands.
  const [tox, toy] = [ix - bx, iy - by]
  const arc = (f: number) => ({ x: tox * f, y: toy * f - Math.sin(Math.PI * f) * 70 })
  tracks.push({
    key: 'spark',
    keys: [
      { t: 0, o: 0, x: 0, y: 0 },
      { t: 3.5, o: 0, x: 0, y: 0, ease: EASE.out },
      { t: 3.62, o: 1, ...arc(0.04), ease: EASE.linear },
      { t: 3.78, o: 1, ...arc(0.3), ease: EASE.linear },
      { t: 3.94, o: 1, ...arc(0.6), ease: EASE.linear },
      { t: 4.1, o: 1, ...arc(0.88), ease: EASE.out },
      { t: 4.2, o: 1, ...arc(1) },
      { t: 4.32, o: 0, ...arc(1) },
    ],
  })
  tracks.push({ key: 'tab', keys: [{ t: 0, o: 0, y: -46 }, { t: 4.08, o: 0, y: -46, ease: EASE.land }, { t: 4.5, o: 1, y: 0 }, { t: 11.3, o: 1, y: 0, ease: EASE.inOut }, { t: 11.7, o: 0, y: 0 }] })
  tracks.push({ key: 'tab-glow', keys: [{ t: 0, o: 0 }, { t: 4.3, o: 0, ease: EASE.out }, { t: 4.55, o: 1, ease: EASE.inOut }, { t: 5.3, o: 0.35 }, { t: 11.3, o: 0.35, ease: EASE.inOut }, { t: 11.7, o: 0 }] })
  // Verify: the check lands after the second pass.
  tracks.push({ key: 'check', origin: '50% 50%', keys: [{ t: 0, o: 0, s: 0.55 }, { t: 5.75, o: 0, s: 0.55, ease: EASE.land }, { t: 6.05, o: 1, s: 1 }, { t: 11.3, o: 1, s: 1, ease: EASE.inOut }, { t: 11.7, o: 0, s: 0.8 }] })
  // Hold: the agent sends, the package rolls in, the gate rises, the lock holds it.
  tracks.push({ key: 'agent-glow', keys: [{ t: 0, o: 0 }, { t: 6.45, o: 0, ease: EASE.out }, { t: 6.75, o: 1, ease: EASE.inOut }, { t: 7.6, o: 0 }] })
  const [pdx, pdy] = delta(2.2, 0)
  const [bkx, bky] = delta(0.16, 0)
  tracks.push({
    key: 'pkg',
    keys: [
      { t: 0, o: 0, x: pdx, y: pdy },
      { t: 6.7, o: 0, x: pdx, y: pdy, ease: EASE.out },
      { t: 6.95, o: 1, x: pdx, y: pdy, ease: EASE.inOut },
      { t: 8.15, o: 1, x: 0, y: 0, ease: EASE.out },
      { t: 8.3, o: 1, x: bkx, y: bky, ease: EASE.inOut },
      { t: 8.48, o: 1, x: 0, y: 0 },
      { t: 11.3, o: 1, x: 0, y: 0, ease: EASE.inOut },
      { t: 11.7, o: 0, x: 0, y: 0 },
    ],
  })
  tracks.push({ key: 'gate', origin: '50% 100%', keys: [{ t: 0, o: 0, sy: 0.05 }, { t: 7.3, o: 0, sy: 0.05, ease: EASE.out }, { t: 7.85, o: 1, sy: 1 }, { t: 11.3, o: 1, sy: 1, ease: EASE.inOut }, { t: 11.7, o: 0, sy: 1 }] })
  tracks.push({ key: 'lock', origin: '50% 50%', keys: [{ t: 0, o: 0, s: 0.55 }, { t: 8.15, o: 0, s: 0.55, ease: EASE.land }, { t: 8.45, o: 1, s: 1 }, { t: 11.3, o: 1, s: 1, ease: EASE.inOut }, { t: 11.7, o: 0, s: 0.8 }] })
  // Signs arrive with their step and leave with the loop.
  const sign = (key: string, tin: number, tout = 11.3) => ({
    key,
    keys: [{ t: 0, o: 0, y: 6 }, { t: tin, o: 0, y: 6, ease: EASE.out }, { t: tin + 0.35, o: 1, y: 0 }, { t: tout, o: 1, y: 0, ease: EASE.inOut }, { t: tout + 0.35, o: 0, y: 0 }],
  })
  tracks.push(sign('s-slow', 1.95, 3.95))
  tracks.push(sign('s-fixed', 6.0))
  tracks.push(sign('s-agent', 6.6))
  tracks.push(sign('s-waits', 8.45))

  return {
    svg: b,
    cycle,
    still: 11.0,
    tracks,
    signs: [
      { key: 's-live', label: 'UrbanCart, in production', tone: ROLE.green, badge: 'Live', at: [40, 520], side: 'right' },
      { key: 's-check', label: 'Checks every minute', tone: ROLE.violet, icon: 'clock', at: [bx, by - 66], side: 'above', to: [bx, by - 28] },
      { key: 's-slow', label: 'Slow query on orders', tone: ROLE.amber, icon: 'alert', at: [fx, fy], side: 'left', to: [bangX - 14, bangY - 44] },
      { key: 's-fixed', label: 'Index added on its own', tone: ROLE.green, icon: 'check', at: [fx, fy], side: 'left', to: [ix - 13, iy - 30] },
      { key: 's-agent', label: 'DROP TABLE carts', tone: ROLE.rose, marks: ['claude', 'codex', 'antigravity'], at: [agx + 58, agy - 30], side: 'right', to: [agx + 24, agy - 14] },
      { key: 's-waits', label: 'Waits for you', tone: ROLE.violet, icon: 'lock', at: [lx - 34, ly + 62], side: 'left', to: [lx - 8, ly + 16] },
    ],
    chapters: [
      { id: 'check', label: 'Check', caption: 'Backenly runs its checks on your backend every minute.', at: 0, rest: 1.0 },
      { id: 'find', label: 'Find', caption: 'The next check finds a slow query on orders, and its cause.', at: 1.6, rest: 3.2 },
      { id: 'fix', label: 'Fix', caption: 'Backenly adds the missing index on its own.', at: 3.5, rest: 4.9 },
      { id: 'verify', label: 'Verify', caption: 'Then it re-runs the check that found it. Confirmed fixed.', at: 5.1, rest: 6.3 },
      { id: 'hold', label: 'Hold', caption: 'Your agent asks to drop the carts table. It waits for you, all 1,284 rows untouched.', at: 6.5, rest: 11.0 },
    ],
    railLabel: 'The repair, step by step',
    description:
      'An illustration of an example store backend: five tables on a platform. Backenly checks it every minute with a ' +
      'sheet of light that crosses every table. The orders table turns amber: a query on it is slow. Backenly adds ' +
      'the missing index on its own, checks again, and a green check confirms the fix. Then your coding agent sends a ' +
      'request to drop the carts table. It stops at a violet gate in front of carts and waits for your approval, with ' +
      'the table and its 1,284 rows untouched.',
  }
}
