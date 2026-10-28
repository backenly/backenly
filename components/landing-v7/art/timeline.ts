/* ─────────────────────────────────────────────────────────────
   The clock the illustrations run on: every track becomes a Web Animation
   on the elements its key marks, all of one loop and all started at the
   same instant, so the art, its signs and the card's rail agree on the time
   without any JavaScript per frame (the landing's rule, ../shared). Seeking
   moves every animation to one moment; pausing stops them where they are.

   The markup a scene draws is its story told, every step's result in view,
   so a page that never runs this (no JavaScript, reduced motion before it
   settles) still shows the whole idea.
───────────────────────────────────────────────────────────── */

import type { Key, Track } from './types'

export interface Timeline {
  /** Seconds into the loop. */
  time(): number
  seek(t: number): void
  play(): void
  pause(): void
  playing(): boolean
  dispose(): void
}

function transformOf(k: Key) {
  const parts: string[] = []
  if (k.x !== undefined || k.y !== undefined) parts.push(`translate(${k.x ?? 0}px, ${k.y ?? 0}px)`)
  if (k.s !== undefined) parts.push(`scale(${k.s})`)
  if (k.sy !== undefined) parts.push(`scaleY(${k.sy})`)
  return parts.join(' ')
}

/** A track's keys as WAAPI keyframes: every property carried on every key, so each segment interpolates cleanly. */
function framesOf(track: Track, length: number): Keyframe[] {
  const keys = [...track.keys].sort((p, q) => p.t - q.t)
  const usesO = keys.some((k) => k.o !== undefined)
  const usesT = keys.some((k) => k.x !== undefined || k.y !== undefined || k.s !== undefined || k.sy !== undefined)
  const carry: Key = { t: 0 }
  const full = keys.map((k) => {
    const merged = { ...carry, ...k }
    Object.assign(carry, k)
    return merged
  })
  if (full[0].t > 0) full.unshift({ ...full[0], t: 0 })
  if (full[full.length - 1].t < length) full.push({ ...full[full.length - 1], t: length, ease: undefined })
  return full.map((k) => {
    const f: Keyframe = { offset: Math.min(1, Math.max(0, k.t / length)), easing: k.ease ?? 'linear' }
    if (usesO) f.opacity = k.o ?? 1
    if (usesT) f.transform = transformOf({ x: k.x ?? 0, y: k.y ?? 0, ...(k.s !== undefined ? { s: k.s } : {}), ...(k.sy !== undefined ? { sy: k.sy } : {}), t: 0 }) || 'none'
    return f
  })
}

export function createTimeline(root: Element, tracks: Track[], cycle: number): Timeline | null {
  if (typeof (root as HTMLElement).animate !== 'function') return null
  const anims: Animation[] = []
  // The clock itself: an empty animation on the root, one loop long, that every other one follows.
  const clock = (root as HTMLElement).animate([{ opacity: 1 }, { opacity: 1 }], { duration: cycle * 1000, iterations: Infinity })
  clock.pause()
  for (const track of tracks) {
    const length = track.loop ?? cycle
    const frames = framesOf(track, length)
    root.querySelectorAll<HTMLElement | SVGElement>(`[data-a="${track.key}"]`).forEach((el) => {
      if (track.origin) {
        el.style.transformBox = 'fill-box'
        el.style.transformOrigin = track.origin
      }
      const anim = el.animate(frames, { duration: length * 1000, iterations: Infinity, fill: 'both', delay: -(track.phase ?? 0) * 1000 })
      anim.pause()
      anims.push(anim)
    })
  }
  const all = [clock, ...anims]
  let running = false

  const at = (t: number) => {
    for (const a of all) a.currentTime = t * 1000
  }
  return {
    time: () => (((Number(clock.currentTime) || 0) / 1000) % cycle + cycle) % cycle,
    seek(t) {
      at(t)
    },
    play() {
      if (running) return
      running = true
      const t = this.time()
      at(t)
      // One start time for all, so they never drift apart.
      const start = (document.timeline.currentTime as number) ?? 0
      for (const a of all) {
        a.play()
        a.startTime = start - t * 1000
      }
    },
    pause() {
      running = false
      const t = this.time()
      for (const a of all) a.pause()
      at(t)
    },
    playing: () => running,
    dispose() {
      running = false
      for (const a of all) a.cancel()
    },
  }
}
