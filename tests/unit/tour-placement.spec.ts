/**
 * Where a tour tooltip lands (lib/tours/placement.ts): beside its target, on the
 * other side when there is no room, inside the viewport, arrow on the target.
 */

import { placeTooltip } from '@/lib/tours/placement'

const VIEW = { width: 1440, height: 900 }
const CARD = { width: 348, height: 180 }

describe('placeTooltip', () => {
  it('puts the card below a target in the top bar, arrow on its centre', () => {
    const target = { top: 8, left: 1272, width: 124, height: 32 } // "Connect agent"
    const p = placeTooltip(target, CARD, VIEW, 'bottom')
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(8 + 32 + 14)
    // Clamped against the right edge, and the arrow still points at the button.
    expect(p.left + CARD.width).toBeLessThanOrEqual(VIEW.width - 12)
    expect(p.left + p.arrow).toBeCloseTo(1272 + 62, 0)
  })

  it('puts the card to the right of a sidebar item, vertically centred on it', () => {
    const target = { top: 400, left: 12, width: 224, height: 36 }
    const p = placeTooltip(target, CARD, VIEW, 'right')
    expect(p.side).toBe('right')
    expect(p.left).toBe(12 + 224 + 14)
    expect(p.top + p.arrow).toBeCloseTo(418, 0)
  })

  it('flips to the other side when the preferred one has no room', () => {
    const nearBottom = { top: 820, left: 600, width: 100, height: 32 }
    expect(placeTooltip(nearBottom, CARD, VIEW, 'bottom').side).toBe('top')
  })

  it('keeps the preferred side when neither side fits, rather than oscillating', () => {
    const tall = { top: 100, left: 600, width: 100, height: 700 }
    expect(placeTooltip(tall, CARD, VIEW, 'bottom').side).toBe('bottom')
  })

  it('never lets the card leave the viewport vertically beside a low target', () => {
    const low = { top: 880, left: 12, width: 224, height: 16 }
    const p = placeTooltip(low, CARD, VIEW, 'right')
    expect(p.top + CARD.height).toBeLessThanOrEqual(VIEW.height - 12)
  })

  it('keeps the arrow off the rounded corners', () => {
    const farRight = { top: 8, left: 1420, width: 16, height: 16 }
    const p = placeTooltip(farRight, CARD, VIEW, 'bottom')
    expect(p.arrow).toBeLessThanOrEqual(CARD.width - 18)
    expect(p.arrow).toBeGreaterThanOrEqual(18)
  })
})
