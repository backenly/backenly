'use client'

import { motion } from 'motion/react'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { PlayPause } from '../landing-v7/scene-ui'

/* ─────────────────────────────────────────────────────────────
   The five regions on one line of longitude, under the daylight as it is
   at this moment: the sun's position is computed from the visitor's clock
   (the usual low-precision solar formulas), so the light, each region's
   local time and its sun or moon are real. Each region's ring fills once a
   minute and pulses when it closes: every project is checked once a minute,
   day and night, which is the page's promise ("fixes itself while you
   sleep") drawn on the world.

   Not a globe and not a map: the regions are named as Backenly's places
   (lib/regions.ts), in longitude order, nothing else claimed. Narrow, the
   line becomes a strip with the regions listed under it. The clock and the
   rings can be paused (WCAG 2.2.2); reduced motion draws them still.
───────────────────────────────────────────────────────────── */

type Region = { id: string; city: string; code: string; tz: string; lat: number; lon: number; high: boolean; left?: boolean; phase: number }

const REGIONS: Region[] = [
  { id: 'oregon', city: 'Oregon', code: 'us-west-2', tz: 'America/Los_Angeles', lat: 45.6, lon: -121.2, high: true, phase: 0 },
  { id: 'virginia', city: 'Virginia', code: 'us-east-1', tz: 'America/New_York', lat: 38.95, lon: -77.45, high: false, phase: 12 },
  { id: 'frankfurt', city: 'Frankfurt', code: 'eu-central-1', tz: 'Europe/Berlin', lat: 50.11, lon: 8.68, high: true, phase: 24 },
  { id: 'mumbai', city: 'Mumbai', code: 'ap-south-1', tz: 'Asia/Kolkata', lat: 19.08, lon: 72.88, high: false, phase: 36 },
  { id: 'singapore', city: 'Singapore', code: 'ap-southeast-1', tz: 'Asia/Singapore', lat: 1.35, lon: 103.82, high: true, left: true, phase: 48 },
]

/** The window of longitude drawn, centred on the regions. */
const LON0 = -173.5
const SPAN = 330
const xOf = (lon: number) => (lon - LON0) / SPAN

const RAD = Math.PI / 180

/** The sun's declination, and its hour angle at a longitude, for a moment (degrees). */
function sun(date: Date) {
  const d = date.getTime() / 86400000 - 10957.5
  const g = (357.529 + 0.98560028 * d) * RAD
  const q = 280.459 + 0.98564736 * d
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD
  const e = (23.439 - 0.00000036 * d) * RAD
  const dec = Math.asin(Math.sin(e) * Math.sin(L))
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24
  return { dec, hourAngle: (lon: number) => (gmst * 15 + lon - ra) * RAD }
}

/** The sun's height above the horizon at a place, in degrees. */
function elevation(s: ReturnType<typeof sun>, lat: number, lon: number) {
  const p = lat * RAD
  return Math.asin(Math.sin(p) * Math.sin(s.dec) + Math.cos(p) * Math.cos(s.dec) * Math.cos(s.hourAngle(lon))) / RAD
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** How much daylight a longitude has (0 to 1), at the regions' latitudes: a twilight tail, then the sun's height. */
function lightAt(s: ReturnType<typeof sun>, lon: number) {
  const e = elevation(s, 30, lon)
  return Math.pow(Math.max(0, Math.sin(Math.max(e, 0) * RAD)), 0.7) * 0.85 + smooth(-9, 0, e) * 0.15
}

/** The sun's hour angle at a longitude, -180..180: negative is morning, positive is afternoon. */
function hourAngle(s: ReturnType<typeof sun>, lon: number) {
  const h = s.hourAngle(lon) / RAD
  return ((((h + 180) % 360) + 360) % 360) - 180
}

const hash = (i: number) => {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}
const noise = (x: number) => {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash(i) * (1 - u) + hash(i + 1) * u
}
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const VIOLET = [167, 139, 250]
const DAWN = [129, 140, 248]
const DUSK = [232, 121, 249]
const tint = (t: number, amount: number) => mix(VIOLET, t < 0 ? DAWN : DUSK, Math.pow(Math.abs(t), 1.3) * amount)

/**
 * The daylight as fibres of light standing on the horizon, the hero's dawn
 * (./DawnField) laid along the world: tallest where the sun is highest,
 * bluer where it is rising, pinker where it is setting, nothing at night.
 * Drawn once per minute and on resize; it never animates.
 */
function DaylightCanvas({ date, className = '' }: { date: Date | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const minute = date ? Math.floor(date.getTime() / 60000) : -1
  useEffect(() => {
    const el = ref.current
    if (!el || minute < 0) return
    const draw = () => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      el.width = Math.max(1, Math.round(r.width * dpr))
      el.height = Math.max(1, Math.round(r.height * dpr))
      const ctx = el.getContext('2d')
      if (!ctx) return
      const W = r.width
      const H = r.height
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const s = sun(new Date(minute * 60000))
      const at = (x: number) => {
        const lon = LON0 + (x / W) * SPAN
        return { k: lightAt(s, lon), t: Math.max(-1, Math.min(1, hourAngle(s, lon) / 95)) }
      }
      // The haze: the light the fibres stand in.
      for (let x = 0; x < W; x += 2) {
        const { k, t } = at(x)
        if (k < 0.01) continue
        const [cr, cg, cb] = tint(t, 0.85)
        const top = H * (1 - 0.92 * k)
        const g = ctx.createLinearGradient(0, H, 0, top)
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.4 * k})`)
        g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${0.15 * k})`)
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
        ctx.fillStyle = g
        ctx.fillRect(x, top, 2, H - top)
      }
      // The fibres: most faint, a few bright, each its own height and width.
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0, x = 0; x < W; i++, x += 2.1) {
        const xx = x + (hash(i * 3.7) - 0.5) * 1.4
        const { k, t } = at(xx)
        if (k < 0.015) continue
        const n = 0.55 * noise(xx / 11) + 0.3 * noise(xx / 3.3 + 17) + 0.15 * noise(xx / 1.4 + 41)
        const bright = Math.pow(hash(i * 1.913 + 7), 2.4)
        const h = H * Math.min(0.97, (0.14 + 0.84 * k) * (0.4 + 0.65 * n))
        const a = (0.09 + 0.74 * k) * (0.2 + 0.8 * bright)
        const [cr, cg, cb] = tint(t, 0.9)
        const g = ctx.createLinearGradient(0, H, 0, H - h)
        g.addColorStop(0, `rgba(${Math.min(255, cr + 40)},${Math.min(255, cg + 40)},${Math.min(255, cb + 10)},${a})`)
        g.addColorStop(0.4, `rgba(${cr},${cg},${cb},${a * 0.55})`)
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
        ctx.strokeStyle = g
        ctx.lineWidth = 0.6 + 0.9 * hash(i * 5.31 + 3)
        ctx.beginPath()
        ctx.moveTo(xx, H)
        ctx.lineTo(xx, H - h)
        ctx.stroke()
      }
      // Where the light meets the horizon.
      for (let x = 0; x < W; x += 2) {
        const { k, t } = at(x)
        if (k < 0.01) continue
        const [cr, cg, cb] = tint(t, 0.7)
        const g = ctx.createLinearGradient(0, H, 0, H - 10)
        g.addColorStop(0, `rgba(${Math.min(255, cr + 50)},${Math.min(255, cg + 50)},255,${0.55 * k})`)
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
        ctx.fillStyle = g
        ctx.fillRect(x, H - 10, 2, 10)
      }
      ctx.globalCompositeOperation = 'source-over'
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [minute])
  return <canvas ref={ref} aria-hidden className={`block h-full w-full ${className}`} />
}

/** Where the light meets the dark at the regions' latitudes (sunrise, sunset), and where it is noon. */
function terminators(date: Date) {
  const s = sun(date)
  const out: { lon: number; kind: 'sunrise' | 'noon' | 'sunset' }[] = []
  let best = { lon: LON0, h: 999 }
  for (let lon = LON0; lon <= LON0 + SPAN; lon += 0.5) {
    const h = Math.abs(hourAngle(s, lon))
    if (h < best.h) best = { lon, h }
  }
  if (best.h < 2) out.push({ lon: best.lon, kind: 'noon' })
  let prev = elevation(s, 30, LON0)
  for (let lon = LON0 + 1; lon <= LON0 + SPAN; lon += 1) {
    const e = elevation(s, 30, lon)
    // Going east, local time is later: dark turning to light is where the sun is rising.
    if (prev < 0 && e >= 0) out.push({ lon, kind: 'sunrise' })
    if (prev >= 0 && e < 0) out.push({ lon, kind: 'sunset' })
    prev = e
  }
  return out
}

const timeIn = (tz: string, date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
const utc = (date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)

export function RegionsSunline() {
  const quiet = useSettledReducedMotion()
  const [now, setNow] = useState<Date | null>(null)
  const [paused, setPaused] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [onScreen, setOnScreen] = useState(false)
  /** The second of the minute when the page first ticked: where each region's ring starts. */
  const [sec0, setSec0] = useState<number | null>(null)
  const box = useRef<HTMLDivElement | null>(null)

  // The minute: after mount (so the server and the first client pass agree), then at each new minute.
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const d = new Date()
      setSec0((v) => v ?? d.getSeconds())
      setNow(d)
      timer = window.setTimeout(tick, 60000 - (d.getTime() % 60000) + 20)
    }
    timer = window.setTimeout(tick, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 640))
    ro.observe(el)
    // Off screen, the rings and the clock stop: nothing is drawn for nobody.
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { rootMargin: '100px' })
    io.observe(el)
    return () => {
      ro.disconnect()
      io.disconnect()
    }
  }, [])

  const edges = now ? terminators(now) : []
  const s = now ? sun(now) : null
  const sec = sec0 ?? 0
  const running = !quiet && !paused
  const live = running && onScreen

  return (
    <div ref={box} className={`relative ${live ? '' : 'sun-paused'}`}>
      <div className="flex items-center gap-[10px] px-[20px] pt-[18px] sm:px-[24px]">
        <span className="inline-flex items-center gap-[7px] text-[12px] text-zinc-400">
          <span className="relative flex h-[6px] w-[6px]">
            <span className="absolute inset-0 rounded-full bg-emerald-400" />
          </span>
          Now
          <UtcClock running={live} ready={!!now} />
        </span>
        <span className="ml-auto hidden items-center gap-[7px] text-[12px] text-zinc-400 sm:inline-flex">
          <Ring size={12} phase={0} sec={sec} still />
          One check a minute, every project
        </span>
        <PlayPause what="clock" paused={!running} onToggle={() => setPaused((p) => !p)} className="ml-[6px]" />
      </div>

      {narrow ? <NarrowLine now={now} s={s} sec={sec} /> : <WideLine now={now} edges={edges} s={s} sec={sec} quiet={quiet} />}

      {/* What the light is (review of 2026-11-27: both reviewers read the violet as a measurement). A phone, which has no
          "One check a minute" above, gets that line here. */}
      <p className="px-[20px] pb-[16px] pt-[6px] text-[12.5px] leading-[1.5] text-zinc-400 sm:px-[24px] sm:pb-[18px]">
        The violet light is where it is daytime right now, and each region sits at its local time.
        <span className="sm:hidden"> Every project is checked once a minute, day or night.</span>
      </p>

      <style>{`
@keyframes sun-ring{from{stroke-dashoffset:var(--c)}to{stroke-dashoffset:0}}
.sun-ring{animation:sun-ring 60s steps(60,end) infinite}
@keyframes sun-ping{0%,95.5%{transform:scale(1);opacity:0}96%{opacity:.6}100%{transform:scale(3.4);opacity:0}}
.sun-ping{animation:sun-ping 60s linear infinite;opacity:0}
.sun-paused .sun-ring,.sun-paused .sun-ping{animation-play-state:paused}
@media (prefers-reduced-motion: reduce){.sun-ring,.sun-ping{animation:none}.sun-ring{stroke-dashoffset:0}}
      `}</style>
    </div>
  )
}

/** The seconds, on their own so only these characters change each second; still while paused. */
function UtcClock({ running, ready }: { running: boolean; ready: boolean }) {
  const [d, setD] = useState<Date | null>(null)
  useEffect(() => {
    if (!ready) return
    const first = window.setTimeout(() => setD(new Date()), 0)
    if (!running) return () => window.clearTimeout(first)
    const id = window.setInterval(() => setD(new Date()), 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [running, ready])
  return <span className="font-mono tabular-nums text-zinc-300">{d ? `${utc(d)} UTC` : '––:––:–– UTC'}</span>
}

/** A minute: a ring that fills over sixty seconds, from where this region's minute stands now. */
function Ring({ size, phase, sec, still = false }: { size: number; phase: number; sec: number; still?: boolean }) {
  const r = size / 2 - 1.5
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={1.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#a78bfa"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={c}
        className={still ? '' : 'sun-ring'}
        style={still ? { strokeDashoffset: c * 0.3 } : { ['--c' as string]: `${c}`, strokeDashoffset: c, animationDelay: `-${(sec + phase) % 60}s` }}
      />
    </svg>
  )
}

function WideLine({ now, edges, s, sec, quiet }: { now: Date | null; edges: { lon: number; kind: 'sunrise' | 'noon' | 'sunset' }[]; s: ReturnType<typeof sun> | null; sec: number; quiet: boolean }) {
  const H = 300
  const horizon = 232
  return (
    <div className="relative mx-[20px] sm:mx-[24px]" style={{ height: H }}>
      {/* The daylight, rising from the horizon. */}
      <motion.div
        aria-hidden
        className="absolute inset-x-0 top-0"
        style={{ height: horizon }}
        initial={quiet ? false : { opacity: 0, y: 10 }}
        whileInView={{ opacity: now ? 1 : 0, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <DaylightCanvas date={now} />
      </motion.div>
      {/* The horizon and its hours: one tick per 15° of longitude. */}
      <div aria-hidden className="absolute inset-x-0 h-px bg-white/[0.14]" style={{ top: horizon }} />
      {Array.from({ length: Math.floor(SPAN / 15) + 1 }, (_, i) => {
        const lon = Math.ceil(LON0 / 15) * 15 + i * 15
        if (lon > LON0 + SPAN) return null
        return <span key={lon} aria-hidden className="absolute w-px bg-white/[0.12]" style={{ left: `${xOf(lon) * 100}%`, top: horizon, height: lon % 90 === 0 ? 7 : 4 }} />
      })}
      {edges.map((e) => (
        <span key={e.kind} className="absolute -translate-x-1/2 whitespace-nowrap text-[12px] text-faint" style={{ left: `${xOf(e.lon) * 100}%`, top: horizon + 14 }}>
          {e.kind === 'sunrise' ? 'Sunrise' : e.kind === 'noon' ? 'Noon' : 'Sunset'}
        </span>
      ))}

      <ul aria-label="Regions">
        {REGIONS.map((r, i) => {
          const x = xOf(r.lon) * 100
          const top = r.high ? 26 : 112
          const day = s ? elevation(s, r.lat, r.lon) > -0.833 : true
          return (
            <li key={r.id} className="absolute" style={{ left: `${x}%`, top: 0, height: horizon }}>
              {/* The stem, from the label down to the horizon. */}
              <motion.span
                aria-hidden
                className="absolute left-0 w-px origin-bottom bg-gradient-to-b from-white/[0.06] to-white/[0.22]"
                style={{ top: top + 6, bottom: 0 }}
                initial={quiet ? false : { scaleY: 0 }}
                whileInView={{ scaleY: 1 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.9, delay: 0.2 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              />
              {/* The region on the horizon, and its minute closing. */}
              <span aria-hidden className="absolute h-[12px] w-[12px] -translate-x-1/2 -translate-y-1/2" style={{ left: 0, top: horizon }}>
                <span className="sun-ping absolute inset-[2px] rounded-full border border-violet-400" style={{ animationDelay: `-${(sec + r.phase) % 60}s` }} />
                <span className="absolute inset-0 rounded-full border-2 border-[#0a0a0d] bg-violet-400" />
              </span>
              <motion.div
                className={`absolute w-max ${r.left ? '-translate-x-full pr-[10px] text-right' : 'pl-[10px]'}`}
                style={{ top }}
                initial={quiet ? false : { opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.7, delay: 0.35 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className={`flex items-center gap-[7px] ${r.left ? 'flex-row-reverse' : ''}`}>
                  <span className="text-[14.5px] font-medium tracking-[-0.01em] text-zinc-100">{r.city}</span>
                  <Ring size={13} phase={r.phase} sec={sec} />
                </span>
                <span className={`mt-[4px] flex items-center gap-[6px] font-mono text-[12px] text-faint ${r.left ? 'flex-row-reverse' : ''}`}>
                  {r.code}
                  <span className="text-zinc-600">·</span>
                  <span className="tabular-nums text-zinc-300">{now ? timeIn(r.tz, now) : '––:––'}</span>
                  {day ? <Sun aria-hidden className="h-[12px] w-[12px] text-zinc-400" strokeWidth={2} /> : <Moon aria-hidden className="h-[12px] w-[12px] text-zinc-400" strokeWidth={2} />}
                  <span className="sr-only">{day ? ', day' : ', night'}</span>
                </span>
              </motion.div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NarrowLine({ now, s, sec }: { now: Date | null; s: ReturnType<typeof sun> | null; sec: number }) {
  return (
    <div className="px-[20px] pb-[8px]">
      <div className="relative mt-[18px] h-[64px]">
        <div aria-hidden className="absolute inset-x-0 top-0 h-[44px]">
          <DaylightCanvas date={now} />
        </div>
        <div aria-hidden className="absolute inset-x-0 top-[44px] h-px bg-white/[0.14]" />
        {REGIONS.map((r) => (
          <span key={r.id} aria-hidden className="absolute top-[44px] h-[8px] w-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0a0a0d] bg-violet-400" style={{ left: `${xOf(r.lon) * 100}%` }} />
        ))}
      </div>
      <ul aria-label="Regions" className="divide-y divide-white/[0.06]">
        {REGIONS.map((r) => {
          const day = s ? elevation(s, r.lat, r.lon) > -0.833 : true
          return (
            <li key={r.id} className="flex h-[46px] items-center gap-[10px]">
              <Ring size={13} phase={r.phase} sec={sec} />
              <span className="text-[14px] font-medium text-zinc-100">{r.city}</span>
              <span className="font-mono text-[12px] text-faint">{r.code}</span>
              <span className="ml-auto flex items-center gap-[6px] font-mono text-[12px] tabular-nums text-zinc-300">
                {now ? timeIn(r.tz, now) : '––:––'}
                {day ? <Sun aria-hidden className="h-[12px] w-[12px] text-zinc-400" strokeWidth={2} /> : <Moon aria-hidden className="h-[12px] w-[12px] text-zinc-400" strokeWidth={2} />}
                  <span className="sr-only">{day ? ', day' : ', night'}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
