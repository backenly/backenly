'use client'

/*
  Custom landing-page icon set.
  Duotone, static, premium-tuned. No hover animation.
  Each icon: 24x24 viewBox, takes { size, color } props. Pass color="currentColor" to inherit.
*/

import { useId, type CSSProperties } from 'react'

type IconProps = {
  size?: number
  color?: string
  style?: CSSProperties
  strokeWidth?: number
  className?: string
}

const defaults = (p: IconProps) => ({
  width: p.size ?? 24,
  height: p.size ?? 24,
  color: p.color ?? 'currentColor',
  sw: p.strokeWidth ?? 1.6,
})

// React-safe unique id - strip colons so it's safe in SVG url(#id) references.
function useGradId(prefix: string) {
  return prefix + useId().replace(/:/g, '')
}

/* =============================================================================
   PRIMITIVES (6) - top-importance icons on the page.
   Each uses a subtle linear gradient on the dominant shape for premium feel.
============================================================================= */

export function DatabaseIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-db-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.08" />
        </linearGradient>
      </defs>
      {/* three stacked table planes - reads like rows, not a cylinder */}
      <rect x="3.25" y="3.25" width="17.5" height="5.2" rx="1.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <rect x="3.25" y="9.4"  width="17.5" height="5.2" rx="1.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <rect x="3.25" y="15.55" width="17.5" height="5.2" rx="1.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      {/* row indicator dots */}
      <circle cx="6.2" cy="5.85" r="0.85" fill={color} />
      <circle cx="6.2" cy="12"   r="0.85" fill={color} />
      <circle cx="6.2" cy="18.15" r="0.85" fill={color} />
      {/* faint row lines */}
      <path d="M9.5 5.85 H17.5" stroke={color} strokeWidth="1" strokeLinecap="round" opacity="0.45" />
      <path d="M9.5 12   H17.5" stroke={color} strokeWidth="1" strokeLinecap="round" opacity="0.45" />
      <path d="M9.5 18.15 H17.5" stroke={color} strokeWidth="1" strokeLinecap="round" opacity="0.45" />
    </svg>
  )
}

export function AuthIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-au-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.30" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* shield body */}
      <path
        d="M12 2.6 L20 5.4 V11.6 C20 16.2 16.8 19.7 12 21.4 C7.2 19.7 4 16.2 4 11.6 V5.4 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* keyhole - circle + bar (lock detail inside the shield) */}
      <circle cx="12" cy="11" r="1.7" stroke={color} strokeWidth={sw} fill="none" />
      <path d="M12 12.7 V15.2" stroke={color} strokeWidth={sw} strokeLinecap="round" />
    </svg>
  )
}

export function RealtimeIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      {/* center node with halo */}
      <circle cx="12" cy="12" r="2.4" fill={color} opacity="0.18" />
      <circle cx="12" cy="12" r="1.6" fill={color} />
      {/* right-side pulse arcs */}
      <path d="M15.5 8.5 a5 5 0 0 1 0 7" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.9" />
      <path d="M17.7 6.3 a8 8 0 0 1 0 11.4" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.55" />
      <path d="M19.9 4.1 a11 11 0 0 1 0 15.8" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.28" />
      {/* left mirror arcs (full radial broadcast) */}
      <path d="M8.5 15.5 a5 5 0 0 1 0 -7" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.9" />
      <path d="M6.3 17.7 a8 8 0 0 1 0 -11.4" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.55" />
      <path d="M4.1 19.9 a11 11 0 0 1 0 -15.8" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.28" />
    </svg>
  )
}

export function StorageIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-st-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="6" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* layered S3-style stack - top ellipse + two layers */}
      <ellipse cx="12" cy="6.5" rx="8" ry="2.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path d="M4 11 C4 12.6 7.6 13.9 12 13.9 S20 12.6 20 11" stroke={color} strokeWidth={sw} fill={`url(#${id})`} />
      <path d="M4 6.5 V11" stroke={color} strokeWidth={sw} />
      <path d="M20 6.5 V11" stroke={color} strokeWidth={sw} />
      <path d="M4 15.5 C4 17.1 7.6 18.4 12 18.4 S20 17.1 20 15.5" stroke={color} strokeWidth={sw} fill={`url(#${id})`} />
      <path d="M4 11 V15.5" stroke={color} strokeWidth={sw} />
      <path d="M20 11 V15.5" stroke={color} strokeWidth={sw} />
      <path d="M4 11 C4 9.4 7.6 8.1 12 8.1 S20 9.4 20 11" stroke={color} strokeWidth={sw * 0.7} opacity="0.5" fill="none" />
      <path d="M4 15.5 C4 13.9 7.6 12.6 12 12.6 S20 13.9 20 15.5" stroke={color} strokeWidth={sw * 0.7} opacity="0.5" fill="none" />
    </svg>
  )
}

export function TriggersIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-tr-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.30" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* event-node rounded square */}
      <rect x="3.25" y="3.25" width="17.5" height="17.5" rx="4.5" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      {/* lightning bolt - filled, sharp */}
      <path
        d="M13.2 5.6 L7.6 13.1 H11.4 L10.4 18.6 L16.2 11 H12.5 Z"
        fill={color} stroke={color} strokeWidth={sw * 0.6} strokeLinejoin="round"
      />
    </svg>
  )
}

export function FunctionsIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      {/* left curly brace */}
      <path
        d="M9 4 C 6.2 4 5.5 5.5 5.5 7.4 V10.4 C 5.5 11.4 4.9 12 4 12 C 4.9 12 5.5 12.6 5.5 13.6 V16.6 C 5.5 18.5 6.2 20 9 20"
        stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      {/* right curly brace */}
      <path
        d="M15 4 C 17.8 4 18.5 5.5 18.5 7.4 V10.4 C 18.5 11.4 19.1 12 20 12 C 19.1 12 18.5 12.6 18.5 13.6 V16.6 C 18.5 18.5 17.8 20 15 20"
        stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      {/* center play triangle - executable function */}
      <path d="M10.6 9.7 L14 12 L10.6 14.3 Z" fill={color} stroke={color} strokeWidth={sw * 0.5} strokeLinejoin="round" />
    </svg>
  )
}

/* =============================================================================
   HOW IT WORKS (4 step icons)
============================================================================= */

export function ChatIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-ch-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* speech bubble with tail */}
      <path
        d="M5 4.5 H19 A2.5 2.5 0 0 1 21.5 7 V14.5 A2.5 2.5 0 0 1 19 17 H11.5 L7.5 20.2 V17 H5 A2.5 2.5 0 0 1 2.5 14.5 V7 A2.5 2.5 0 0 1 5 4.5 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* three typing dots */}
      <circle cx="8.5" cy="10.75" r="1.1" fill={color} />
      <circle cx="12" cy="10.75"  r="1.1" fill={color} />
      <circle cx="15.5" cy="10.75" r="1.1" fill={color} />
    </svg>
  )
}

export function BuildIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-bu-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* AI build sparkle - 4-pointed star (custom shape, not lucide Sparkles) */}
      <path
        d="M12 3 L13.6 9.4 L20 11 L13.6 12.6 L12 19 L10.4 12.6 L4 11 L10.4 9.4 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* small accent star, top-right */}
      <path
        d="M18.5 4.5 L19.1 6.4 L21 7 L19.1 7.6 L18.5 9.5 L17.9 7.6 L16 7 L17.9 6.4 Z"
        fill={color} opacity="0.85"
      />
    </svg>
  )
}

export function GlobeIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-gl-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.26" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path d="M3 12 H21" stroke={color} strokeWidth={sw} />
      <path d="M12 3 C7 7 7 17 12 21" stroke={color} strokeWidth={sw} fill="none" />
      <path d="M12 3 C17 7 17 17 12 21" stroke={color} strokeWidth={sw} fill="none" />
      {/* deploy pin */}
      <circle cx="16.5" cy="7.6" r="1.4" fill={color} />
      <circle cx="16.5" cy="7.6" r="2.8" fill="none" stroke={color} strokeWidth={sw * 0.7} opacity="0.5" />
    </svg>
  )
}

export function HeartPulseIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-hp-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* heart shape */}
      <path
        d="M12 20.4 C 5.5 16.5 2.5 13 2.5 8.9 A 4.4 4.4 0 0 1 12 6.6 A 4.4 4.4 0 0 1 21.5 8.9 C 21.5 13 18.5 16.5 12 20.4 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* EKG line cutting through */}
      <path
        d="M3 11.5 H7.5 L9 8.5 L11 14.5 L13 10 L14.5 12 H21"
        stroke={color} strokeWidth={sw * 1.2} strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </svg>
  )
}

/* =============================================================================
   CAPABILITIES BENTO - extras (Database/Auth/Realtime/Storage/Triggers reused)
============================================================================= */

export function CodeIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M8.5 7 L3.5 12 L8.5 17" stroke={color} strokeWidth={sw * 1.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.5 7 L20.5 12 L15.5 17" stroke={color} strokeWidth={sw * 1.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 5 L10.5 19" stroke={color} strokeWidth={sw * 1.2} strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

/* =============================================================================
   AUTONOMOUS (3)
============================================================================= */

export function EyeIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-ey-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="2" y1="6" x2="22" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.26" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* eye almond */}
      <path
        d="M2 12 C 5 6.5 8.5 4 12 4 S 19 6.5 22 12 C 19 17.5 15.5 20 12 20 S 5 17.5 2 12 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* iris + pupil */}
      <circle cx="12" cy="12" r="3.4" fill={color} opacity="0.18" stroke={color} strokeWidth={sw} />
      <circle cx="12" cy="12" r="1.4" fill={color} />
      {/* tiny radar dot */}
      <circle cx="14.3" cy="9.6" r="0.7" fill={color} opacity="0.9" />
    </svg>
  )
}

export function WrenchIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-wr-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* wrench body - diagonal shaft with open-end head */}
      <path
        d="M14.5 3 A 4.5 4.5 0 0 0 19.4 9.7 L 9.7 19.4 A 3 3 0 0 1 4.6 14.3 L 14.3 4.6 A 4.5 4.5 0 0 0 14.5 3 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* grip dot at handle end */}
      <circle cx="6.6" cy="17.4" r="0.95" fill={color} />
    </svg>
  )
}

export function ShieldCheckIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-sc-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.30" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.6 L20 5.4 V11.6 C20 16.2 16.8 19.7 12 21.4 C7.2 19.7 4 16.2 4 11.6 V5.4 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      <path d="M8.2 12 L11 14.8 L15.8 9.6" stroke={color} strokeWidth={sw * 1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/* =============================================================================
   PERSONAS (3)
============================================================================= */

export function UserIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-us-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="8" r="3.8" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path
        d="M3.6 20.5 C 4.4 16.3 7.8 13.8 12 13.8 S 19.6 16.3 20.4 20.5"
        stroke={color} strokeWidth={sw} fill={`url(#${id})`} strokeLinejoin="round"
      />
      {/* tiny spark - solo founder energy */}
      <path d="M18.4 4.5 L18.9 5.9 L20.3 6.4 L18.9 6.9 L18.4 8.3 L17.9 6.9 L16.5 6.4 L17.9 5.9 Z" fill={color} opacity="0.9" />
    </svg>
  )
}

export function PaletteIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-pa-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path
        d="M12 3 C 6.5 3 2.5 6.8 2.5 11.5 C 2.5 16 6.5 19.5 11 19.5 C 12.6 19.5 13 18.6 12.7 17.5 C 12.2 16 13.4 14.8 15 14.8 H17 C 19.5 14.8 21.5 13 21.5 10.5 C 21.5 6.4 17.3 3 12 3 Z"
        fill={`url(#${id})`} stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      {/* paint dots */}
      <circle cx="7.5" cy="9" r="1.1" fill={color} />
      <circle cx="11" cy="6.7" r="1.1" fill={color} opacity="0.7" />
      <circle cx="15.2" cy="7.5" r="1.1" fill={color} opacity="0.85" />
      <circle cx="17.5" cy="11" r="1.1" fill={color} opacity="0.6" />
    </svg>
  )
}

export function UsersIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  const id = useGradId('bk-ut-')
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="2" y1="3" x2="22" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {/* back-left and back-right small figures */}
      <circle cx="6.5" cy="8.5" r="2.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path d="M1.5 19 C 2.2 15.8 4.2 14.2 6.5 14.2" stroke={color} strokeWidth={sw} fill={`url(#${id})`} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17.5" cy="8.5" r="2.6" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path d="M22.5 19 C 21.8 15.8 19.8 14.2 17.5 14.2" stroke={color} strokeWidth={sw} fill={`url(#${id})`} strokeLinecap="round" strokeLinejoin="round" />
      {/* front centre figure (larger) */}
      <circle cx="12" cy="9.5" r="3.3" fill={`url(#${id})`} stroke={color} strokeWidth={sw} />
      <path
        d="M5.8 20.8 C 6.8 17 9.2 15.2 12 15.2 S 17.2 17 18.2 20.8"
        stroke={color} strokeWidth={sw} fill={`url(#${id})`} strokeLinejoin="round"
      />
    </svg>
  )
}

/* =============================================================================
   SMALL UTILITY ICONS (used in mini-mockups + chips)
============================================================================= */

export function LockIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" fill={color} fillOpacity="0.18" stroke={color} strokeWidth={sw} />
      <path d="M7.5 10.5 V7.5 A4.5 4.5 0 0 1 16.5 7.5 V10.5" stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" />
      <circle cx="12" cy="15.4" r="1.3" fill={color} />
      <path d="M12 16.7 V18.6" stroke={color} strokeWidth={sw} strokeLinecap="round" />
    </svg>
  )
}

export function RefreshIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M20 7 A8 8 0 0 0 5.1 9.5" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
      <path d="M20 3 V7 H16" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M4 17 A8 8 0 0 0 18.9 14.5" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
      <path d="M4 21 V17 H8" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

export function LayoutGridIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <rect x="3.5" y="3.5"  width="7" height="7" rx="1.6" fill={color} fillOpacity="0.30" stroke={color} strokeWidth={sw} />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" fill={color} fillOpacity="0.12" stroke={color} strokeWidth={sw} />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" fill={color} fillOpacity="0.12" stroke={color} strokeWidth={sw} />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" fill={color} fillOpacity="0.30" stroke={color} strokeWidth={sw} />
    </svg>
  )
}

export function FolderIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M3 7 V6 A2 2 0 0 1 5 4 H9.5 L11.5 6.5 H19 A2 2 0 0 1 21 8.5 V9.5" stroke={color} strokeWidth={sw} fill={color} fillOpacity="0.18" strokeLinejoin="round" />
      <path d="M3 9 H21 V18 A2 2 0 0 1 19 20 H5 A2 2 0 0 1 3 18 Z" stroke={color} strokeWidth={sw} fill={color} fillOpacity="0.10" strokeLinejoin="round" />
    </svg>
  )
}

export function AlertTriangleIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path
        d="M12 3.2 L21.4 19.4 A1.8 1.8 0 0 1 19.8 22 H4.2 A1.8 1.8 0 0 1 2.6 19.4 Z"
        fill={color} fillOpacity="0.18" stroke={color} strokeWidth={sw} strokeLinejoin="round"
      />
      <path d="M12 9.5 V14" stroke={color} strokeWidth={sw * 1.3} strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="0.95" fill={color} />
    </svg>
  )
}

export function GaugeIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M4 16 A8 8 0 1 1 20 16" stroke={color} strokeWidth={sw} strokeLinecap="round" fill={color} fillOpacity="0.10" />
      <path d="M6.6 11 L7.6 11.8" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.55" />
      <path d="M12 8.4 V9.6" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.55" />
      <path d="M17.4 11 L16.4 11.8" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.55" />
      <path d="M12 16 L15.8 10.7" stroke={color} strokeWidth={sw * 1.3} strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.3" fill={color} />
    </svg>
  )
}

export function CheckCircleIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <circle cx="12" cy="12" r="9" fill={color} fillOpacity="0.18" stroke={color} strokeWidth={sw} />
      <path d="M8 12.2 L11 15.2 L16 9.8" stroke={color} strokeWidth={sw * 1.35} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

export function UndoIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M4 7 V13 H10" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 13 A8 8 0 1 1 7 19" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
    </svg>
  )
}

export function ActivityIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path
        d="M2.5 12 H6.5 L9 6 L13 18 L15.5 12 H21.5"
        stroke={color} strokeWidth={sw * 1.35} strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </svg>
  )
}

/* =============================================================================
   BUTTON ARROW - refined
============================================================================= */

export function ArrowRightIcon(p: IconProps) {
  const { width, height, color, sw } = defaults(p)
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" style={p.style} className={p.className} aria-hidden>
      <path d="M4 12 H20" stroke={color} strokeWidth={sw * 1.5} strokeLinecap="round" />
      <path d="M13.5 5.5 L20 12 L13.5 18.5" stroke={color} strokeWidth={sw * 1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
