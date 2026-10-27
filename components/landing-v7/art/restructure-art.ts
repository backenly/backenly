/* ─────────────────────────────────────────────────────────────
   "Your schema restructures itself", drawn: orders is a stack of column
   layers, graphite for its own columns and violet for refund_amount,
   refund_reason and refunded_at, the second job (lib/structural-evolution:
   the one installed primitive, structural extraction).

     Notice    the violet layers glow; changing them locks all of orders
     Rehearse  a dashed copy beside it takes the move, then rolls back
     Approve   your approval lands, and only then does anything run
     Move      order_refunds is built beside orders: its keys first, then
               each refund layer copied across, kept in step both ways
     Open      new code reads order_refunds while your app keeps using
               orders; nothing is removed from orders

   The old columns stay on orders (dropping them is a person's step, never
   run by software), so the copy flies across and orders keeps its violet layers.
───────────────────────────────────────────────────────────── */

import { makeScene, sceneDefs, shade, glow, lightPool, HUE, INK, ROLE } from './iso'
import { topGlyph, statusCircle } from './symbols'
import { EASE, type Art, type Track } from './types'

const W = 1200, H = 560

export function restructureArt(ns: string): Art {
  const sc = makeScene(510, 140, 40, ns)
  const { P, poly, box, topText, rows, delta } = sc
  const a = (key: string) => `data-a="${key}"`
  let b = ''

  b += sceneDefs(ns)
  b += lightPool(ns, '51%', '56%', W, H)
  b += box(0, 0, -0.6, 11.6, 5.6, 0.6, HUE.plinth, { edge: 0.2, shadowOpacity: 0.6 })

  const lh = 0.32, gap = 0.07, step = lh + gap
  const ox = 1.0, oy = 1.1, ow = 3.4, od = 3.4
  const nx = 7.2, ny = 1.1

  // The rehearsal: a dashed copy where order_refunds will stand, taking the move and then rolling back.
  {
    const z1 = 5 * step - gap
    const outline = (pts3: [number, number, number][]) => `<polyline points="${pts3.map((p) => P(...p).join(',')).join(' ')}" fill="none" stroke="#a7f3d0" stroke-width="1.6" stroke-dasharray="5 5" stroke-linejoin="round"/>`
    b += `<g ${a('ghost')} opacity="0">`
    b += poly([[nx, ny, z1], [nx + ow, ny, z1], [nx + ow, ny + od, z1], [nx, ny + od, z1]], '#34d399', 'opacity="0.08"')
    b += outline([[nx, ny + od, 0], [nx + ow, ny + od, 0], [nx + ow, ny, 0]])
    b += outline([[nx, ny + od, z1], [nx + ow, ny + od, z1], [nx + ow, ny, z1], [nx, ny, z1], [nx, ny + od, z1]])
    b += outline([[nx, ny + od, 0], [nx, ny + od, z1]]) + outline([[nx + ow, ny + od, 0], [nx + ow, ny + od, z1]]) + outline([[nx + ow, ny, 0], [nx + ow, ny, z1]])
    b += '</g>'
  }

  // orders: seven column layers; the top three are refunds.
  const names = ['id', 'customer_id', 'total', 'status', 'refund_amount', 'refund_reason', 'refunded_at']
  names.forEach((_, i) => (b += box(ox, oy, i * step, ow, od, lh, i >= 4 ? HUE.violet : HUE.graphite, { shadow: i === 0, edge: 0.42 })))
  const oTop = names.length * step - gap
  b += topGlyph(sc, ox + 0.28, oy + 0.24, oTop, 'receipt', 0.44, shade(HUE.violet[2], -0.45), 0.7)
  b += topText(ox + 0.84, oy + 0.6, oTop, 'orders', { size: 14, opacity: 0.7 })
  b += rows(ox, oy + 0.35, oTop, ow, od - 0.35, 7, shade(HUE.violet[2], -0.35), { top: 0.7, gap: 0.34, opacity: 0.22 })
  const [rgx, rgy] = P(ox + ow / 2, oy + od / 2, 5.2 * step)
  b += glow(ns, 'rfG', rgx, rgy, 150, '#a78bfa', 0.42, `${a('refund-glow')} opacity="0"`)
  const [olx, oly] = P(ox + ow * 0.62, oy + od * 0.3, oTop)
  b += statusCircle(ns, 'olock', olx, oly - 36, 13, 'lock', ROLE.amber, ROLE.amberInk, `${a('olock')} opacity="0"`)

  // The copies in the rehearsal: the refund layers, sliding into the dashed copy.
  const fromOrders = delta(ox - nx, 0, 2 * step)
  b += `<g ${a('ghost-layers')} opacity="0">`
  for (let i = 0; i < 3; i++) b += box(nx, ny, (2 + i) * step, ow, od, lh, HUE.violet, { shadow: false, edge: 0.3 })
  b += '</g>'

  // The bridge: rows copied across and kept in step, both ways.
  const bz = 1.6
  b += `<g ${a('bridge')}>`
  b += poly([[ox + ow, oy + 1.25, bz], [nx, oy + 1.25, bz], [nx, oy + 2.15, bz], [ox + ow, oy + 2.15, bz]], '#a78bfa', 'opacity="0.24"')
  b += poly([[ox + ow, oy + 2.15, bz], [nx, oy + 2.15, bz], [nx, oy + 2.15, bz - 0.12], [ox + ow, oy + 2.15, bz - 0.12]], '#6a43e0', 'opacity="0.55"')
  const [fx0, fy0] = P(ox + ow, oy + 1.7, bz)
  const [fdx, fdy] = delta(nx - ox - ow, 0)
  for (let k = 0; k < 4; k++) b += `<circle cx="${fx0}" cy="${fy0}" r="4.4" fill="#ede9fe" ${a(`bflow-${k}`)}/>`
  b += '</g>'

  // order_refunds: its keys, then the three refund layers.
  ;[0, 1].forEach((i) => (b += box(nx, ny, i * step, ow, od, lh, HUE.graphite, { shadow: i === 0, edge: 0.45, attrs: a(`base-${i}`) })))
  ;[0, 1, 2].forEach((i) => {
    b += `<g ${a(`copy-${i}`)}>${box(nx, ny, (2 + i) * step, ow, od, lh, HUE.violet, { shadow: false, edge: 0.45 })}</g>`
  })
  // Its name is printed once the last layer has landed, so it never rides across on top of orders.
  {
    const nTop = 5 * step - gap
    b += `<g ${a('new-label')}>`
    b += topGlyph(sc, nx + 0.28, ny + 0.24, nTop, 'undo', 0.44, shade(HUE.violet[2], -0.45), 0.7)
    b += topText(nx + 0.84, ny + 0.6, nTop, 'order_refunds', { size: 12.5, opacity: 0.72 })
    b += rows(nx, ny + 0.35, nTop, ow, od - 0.35, 7, shade(HUE.violet[2], -0.35), { top: 0.7, gap: 0.34, opacity: 0.22 })
    b += '</g>'
  }
  const [stx, sty0] = P(nx + ow * 0.9, ny + od * 0.15, 5 * step - gap)
  const sty = sty0 - 18
  b += statusCircle(ns, 'ok', stx, sty - 40, 14, 'check', ROLE.violetLine, '#241a45', a('stamp'))

  // Your app (left) keeps using orders; new code (right) can use order_refunds.
  b += box(-3.2, 2.0, -0.4, 1.9, 1.9, 0.4, HUE.plinth, { edge: 0.18, shadowOpacity: 0.45 })
  b += box(-2.9, 2.3, 0, 1.3, 1.3, 1.0, HUE.graphite, { edge: 0.3 })
  b += topGlyph(sc, -2.55, 2.62, 1.0, 'app', 0.62, INK.label, 0.85)
  b += box(12.6, 2.0, -0.4, 1.9, 1.9, 0.4, HUE.plinth, { edge: 0.18, shadowOpacity: 0.45 })
  b += `<g ${a('newcode')}>${box(12.9, 2.3, 0, 1.3, 1.3, 1.0, HUE.graphite, { edge: 0.3 })}${topGlyph(sc, 13.25, 2.62, 1.0, 'code', 0.62, INK.label, 0.85)}</g>`
  const [ax0, ay0] = P(-1.6, 2.95, 0.05)
  const [adx, ady] = delta(ox + 1.6, 0)
  for (let k = 0; k < 4; k++) b += `<circle cx="${ax0}" cy="${ay0}" r="4.4" fill="#e4e4e7" ${a(`aflow-${k}`)}/>`
  const [nx0, ny0] = P(nx + ow, 2.95, 0.05)
  const [ndx, ndy] = delta(12.9 - nx - ow, 0)
  b += `<g ${a('nflow')}>`
  for (let k = 0; k < 4; k++) b += `<circle cx="${nx0}" cy="${ny0}" r="4.4" fill="#e4e4e7" ${a(`nflow-${k}`)}/>`
  b += '</g>'
  const [ncx, ncy] = P(13.55, 2.95, 1.0)
  b += glow(ns, 'ncG', ncx, ncy, 64, '#e4e4e7', 0.3, `${a('newcode-glow')} opacity="0"`)

  /* ── Choreography (seconds of a 12.5 s loop) ────────────────────────── */
  const cycle = 12.5
  const tracks: Track[] = []
  // Ambient traffic: dots travelling their path on their own short loop.
  const flow = (key: string, dx: number, dy: number, loop: number, phase: number) =>
    tracks.push({ key, loop, phase, keys: [{ t: 0, o: 0, x: 0, y: 0, ease: EASE.linear }, { t: loop * 0.15, o: 1, x: dx * 0.15, y: dy * 0.15, ease: EASE.linear }, { t: loop * 0.85, o: 1, x: dx * 0.85, y: dy * 0.85, ease: EASE.linear }, { t: loop, o: 0, x: dx, y: dy }] })
  for (let k = 0; k < 4; k++) flow(`aflow-${k}`, adx, ady, 1.6, k * 0.4)
  for (let k = 0; k < 4; k++) flow(`nflow-${k}`, ndx, ndy, 1.6, k * 0.4)
  // The bridge carries rows both ways: two dots each way.
  for (let k = 0; k < 4; k++) {
    const back = k % 2 === 1
    tracks.push({ key: `bflow-${k}`, loop: 1.8, phase: (k >> 1) * 0.9, keys: back
      ? [{ t: 0, o: 0, x: fdx, y: fdy, ease: EASE.linear }, { t: 0.3, o: 1, x: fdx * 0.83, y: fdy * 0.83, ease: EASE.linear }, { t: 1.5, o: 1, x: fdx * 0.17, y: fdy * 0.17, ease: EASE.linear }, { t: 1.8, o: 0, x: 0, y: 0 }]
      : [{ t: 0, o: 0, x: 0, y: 0, ease: EASE.linear }, { t: 0.3, o: 1, x: fdx * 0.17, y: fdy * 0.17, ease: EASE.linear }, { t: 1.5, o: 1, x: fdx * 0.83, y: fdy * 0.83, ease: EASE.linear }, { t: 1.8, o: 0, x: fdx, y: fdy }] })
  }
  // Notice.
  tracks.push({ key: 'refund-glow', keys: [{ t: 0, o: 0 }, { t: 0.3, o: 0, ease: EASE.inOut }, { t: 0.9, o: 1, ease: EASE.inOut }, { t: 1.5, o: 0.35, ease: EASE.inOut }, { t: 2.0, o: 0.9, ease: EASE.inOut }, { t: 2.6, o: 0 }] })
  tracks.push({ key: 'olock', origin: '50% 50%', keys: [{ t: 0, o: 0, s: 0.6 }, { t: 1.0, o: 0, s: 0.6, ease: EASE.land }, { t: 1.3, o: 1, s: 1 }, { t: 2.2, o: 1, s: 1, ease: EASE.in }, { t: 2.45, o: 0, s: 0.75 }] })
  // Rehearse: the dashed copy appears, takes the layers, and rolls back.
  tracks.push({ key: 'ghost', keys: [{ t: 0, o: 0 }, { t: 2.6, o: 0, ease: EASE.out }, { t: 2.95, o: 1 }, { t: 4.4, o: 1, ease: EASE.inOut }, { t: 4.85, o: 0 }] })
  tracks.push({
    key: 'ghost-layers',
    keys: [
      { t: 0, o: 0, x: fromOrders[0], y: fromOrders[1] },
      { t: 3.0, o: 0, x: fromOrders[0], y: fromOrders[1], ease: EASE.out },
      { t: 3.15, o: 0.55, x: fromOrders[0], y: fromOrders[1], ease: EASE.inOut },
      { t: 3.85, o: 0.55, x: 0, y: 0 },
      { t: 4.3, o: 0.55, x: 0, y: 0, ease: EASE.inOut },
      { t: 4.75, o: 0, x: 0, y: 0 },
    ],
  })
  // Approve: the stamp lands; nothing runs before it.
  tracks.push({ key: 'stamp', origin: '50% 50%', keys: [{ t: 0, o: 0, s: 0.55 }, { t: 5.1, o: 0, s: 0.55, ease: EASE.land }, { t: 5.45, o: 1, s: 1 }, { t: 11.8, o: 1, s: 1, ease: EASE.inOut }, { t: 12.2, o: 0, s: 0.8 }] })
  // Move: the keys rise, the refund layers fly across one by one, the bridge opens.
  ;[0, 1].forEach((i) => tracks.push({ key: `base-${i}`, keys: [{ t: 0, o: 0, y: 22 }, { t: 6.55 + i * 0.12, o: 0, y: 22, ease: EASE.out }, { t: 7.0 + i * 0.12, o: 1, y: 0 }, { t: 11.8, o: 1, y: 0, ease: EASE.inOut }, { t: 12.2, o: 0, y: 0 }] }))
  ;[0, 1, 2].forEach((i) => {
    const t0 = 7.15 + i * 0.42
    const [sx, sy] = delta(ox - nx, 0, 2 * step)
    tracks.push({
      key: `copy-${i}`,
      keys: [
        { t: 0, o: 0, x: sx, y: sy },
        { t: t0, o: 0, x: sx, y: sy, ease: EASE.out },
        { t: t0 + 0.12, o: 1, x: sx, y: sy - 6, ease: EASE.inOut },
        { t: t0 + 0.5, o: 1, x: sx * 0.45, y: sy * 0.45 - 26, ease: EASE.inOut },
        { t: t0 + 0.85, o: 1, x: 0, y: 0, ease: EASE.out },
        { t: 11.8, o: 1, x: 0, y: 0, ease: EASE.inOut },
        { t: 12.2, o: 0, x: 0, y: 0 },
      ],
    })
  })
  tracks.push({ key: 'new-label', keys: [{ t: 0, o: 0 }, { t: 8.85, o: 0, ease: EASE.out }, { t: 9.2, o: 1 }, { t: 11.8, o: 1, ease: EASE.inOut }, { t: 12.2, o: 0 }] })
  tracks.push({ key: 'bridge', keys: [{ t: 0, o: 0 }, { t: 7.0, o: 0, ease: EASE.out }, { t: 7.4, o: 1 }, { t: 11.8, o: 1, ease: EASE.inOut }, { t: 12.2, o: 0 }] })
  // Open: new code wakes and reads the new table.
  tracks.push({ key: 'newcode', keys: [{ t: 0, o: 0.4 }, { t: 9.7, o: 0.4, ease: EASE.out }, { t: 10.05, o: 1 }, { t: 11.8, o: 1, ease: EASE.inOut }, { t: 12.2, o: 0.4 }] })
  tracks.push({ key: 'newcode-glow', keys: [{ t: 0, o: 0 }, { t: 9.75, o: 0, ease: EASE.out }, { t: 10.1, o: 1, ease: EASE.inOut }, { t: 11.0, o: 0.45 }, { t: 11.8, o: 0.45, ease: EASE.inOut }, { t: 12.2, o: 0 }] })
  tracks.push({ key: 'nflow', keys: [{ t: 0, o: 0 }, { t: 9.85, o: 0, ease: EASE.out }, { t: 10.2, o: 1 }, { t: 11.8, o: 1, ease: EASE.inOut }, { t: 12.2, o: 0 }] })
  const sign = (key: string, tin: number, tout = 11.8) => ({
    key,
    keys: [{ t: 0, o: 0, y: 6 }, { t: tin, o: 0, y: 6, ease: EASE.out }, { t: tin + 0.35, o: 1, y: 0 }, { t: tout, o: 1, y: 0, ease: EASE.inOut }, { t: tout + 0.35, o: 0, y: 0 }],
  })
  tracks.push(sign('s-lock', 1.05, 2.25))
  tracks.push(sign('s-rehearse', 2.9, 4.45))
  tracks.push(sign('s-approved', 5.3))
  tracks.push(sign('s-step', 8.75))
  tracks.push(sign('s-new', 9.95))

  const [appx, appy] = P(-2.25, 2.95, 1.0)
  const [bx2, by2] = P(ox + ow + (nx - ox - ow) * 0.5, oy + 1.7, bz)
  const [rfx, rfy] = P(ox + ow, oy + od * 0.5, oTop - 0.6)
  return {
    svg: b,
    cycle,
    still: 11.6,
    tracks,
    signs: [
      { key: 's-app', label: 'Your app', tone: ROLE.neutral, icon: 'app', at: [appx, appy - 58], side: 'above', to: [appx, appy - 20] },
      { key: 's-refunds', label: 'Refunds: a second job inside orders', tone: ROLE.violet, icon: 'receipt', at: [rfx + 10, rfy - 118], side: 'above', to: [rfx + 2, rfy - 6] },
      { key: 's-lock', label: 'Changing refunds locks orders', tone: ROLE.amber, icon: 'lock', at: [olx + 26, oly - 36], side: 'right', to: [olx + 15, oly - 36] },
      { key: 's-rehearse', label: 'Rehearsed on a copy, rolled back', tone: ROLE.green, icon: 'flask', at: [stx + 30, sty - 40], side: 'right', to: [stx + 14, sty - 40] },
      { key: 's-approved', label: 'Approved by you', tone: ROLE.violet, icon: 'check', at: [stx + 30, sty - 40], side: 'right', to: [stx + 16, sty - 40] },
      { key: 's-step', label: 'Kept in step', tone: ROLE.violet, icon: 'sync', at: [bx2 - 4, by2 + 74], side: 'below', to: [bx2, by2 + 12] },
      { key: 's-new', label: 'New code uses order_refunds', tone: ROLE.neutral, icon: 'code', at: [ncx + 4, ncy + 46], side: 'below', to: [ncx, ncy + 16] },
    ],
    chapters: [
      { id: 'notice', label: 'Notice', caption: 'Refunds are a second job inside orders, and changing them has locked the table.', at: 0, rest: 2.0 },
      { id: 'rehearse', label: 'Rehearse', caption: 'The whole change runs first on a copy of the real rows, then rolls back.', at: 2.6, rest: 4.1 },
      { id: 'approve', label: 'Approve', caption: 'Nothing runs until you approve that exact plan. Agents can only read it.', at: 5.0, rest: 6.2 },
      { id: 'move', label: 'Move', caption: 'order_refunds is built beside orders, kept in step, filled and checked.', at: 6.5, rest: 9.4 },
      { id: 'open', label: 'Open', caption: 'Old and new code both keep working. Nothing is removed, and undo stays available.', at: 9.7, rest: 11.6 },
    ],
    railLabel: 'The change, step by step',
    description:
      'An illustration of an example store backend. The orders table is drawn as a stack of column layers: graphite for ' +
      'its own columns and violet for three refund columns, a second job inside it. Changing those columns locks orders. ' +
      'Backenly rehearses moving them on a copy and rolls the copy back, then waits for your approval. Once you ' +
      'approve, a new order_refunds table is built beside orders, the refund columns are copied across and kept in ' +
      'step both ways, and new code can read order_refunds while your app keeps using orders. Nothing is removed ' +
      'from orders.',
  }
}
