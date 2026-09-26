/**
 * Where a tour tooltip goes, relative to the element it explains.
 *
 * Pure so it can be tested without a browser: the component measures, this
 * decides. It prefers the requested side, flips to the opposite one when that
 * side has no room, clamps the card inside the viewport, and aims the arrow at
 * the target's centre even after clamping moved the card.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'

export interface Box {
  top: number
  left: number
  width: number
  height: number
}

export interface Placement {
  side: Side
  top: number
  left: number
  /** Arrow position along the card's edge that faces the target, in px from that edge's start. */
  arrow: number
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

export function placeTooltip(
  target: Box,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: Side,
  gap = 14,
  margin = 12,
): Placement {
  const room: Record<Side, number> = {
    top: target.top - margin,
    bottom: viewport.height - (target.top + target.height) - margin,
    left: target.left - margin,
    right: viewport.width - (target.left + target.width) - margin,
  }
  const need = (s: Side) => (s === 'top' || s === 'bottom' ? card.height : card.width) + gap
  const side = room[preferred] >= need(preferred) || room[OPPOSITE[preferred]] < need(OPPOSITE[preferred])
    ? preferred
    : OPPOSITE[preferred]

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))
  const cx = target.left + target.width / 2
  const cy = target.top + target.height / 2

  let top: number
  let left: number
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? target.top + target.height + gap : target.top - gap - card.height
    left = clamp(cx - card.width / 2, margin, viewport.width - margin - card.width)
  } else {
    left = side === 'right' ? target.left + target.width + gap : target.left - gap - card.width
    top = clamp(cy - card.height / 2, margin, viewport.height - margin - card.height)
  }

  // Keep the arrow on the card, away from its rounded corners.
  const edge = side === 'top' || side === 'bottom' ? card.width : card.height
  const aim = side === 'top' || side === 'bottom' ? cx - left : cy - top
  return { side, top, left, arrow: clamp(aim, 18, edge - 18) }
}
