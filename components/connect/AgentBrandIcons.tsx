'use client'

/**
 * AgentBrandIcons — the coding-agent logomarks used on the Connect › Agents tab
 * (AgentInstallGuide). Self-contained inline SVGs (no network fetch, no icon
 * font) so they render on the dark inspector surface with the brand's own
 * accent, while everything around them stays in the flat monochrome inspector
 * language.
 *
 * Each mark carries its brand color internally so callers just place it on a
 * neutral tile — no per-call theming. Marks are drawn on a 24×24 grid and
 * scale from the `size` prop.
 */

import type { FC } from 'react'

export interface BrandIconProps {
  size?: number
  className?: string
}

/* Anthropic / Claude — the radial sunburst, in Claude clay (#D97757). */
const CLAUDE_RAYS = Array.from({ length: 12 }, (_, i) => i * 30)
export const ClaudeIcon: FC<BrandIconProps> = ({ size = 18, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    {CLAUDE_RAYS.map((a) => (
      <path
        key={a}
        d="M11.73 10.9 L11.87 3.15 A0.55 0.55 0 0 1 12.13 3.15 L12.27 10.9 Z"
        fill="#D97757"
        transform={`rotate(${a} 12 12)`}
      />
    ))}
  </svg>
)

/* Cursor — the isometric cube, three faces in a single neutral hue. */
export const CursorIcon: FC<BrandIconProps> = ({ size = 18, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path d="M12 2.6 L20.5 7.3 L12 12 L3.5 7.3 Z" fill="#E7E7EA" fillOpacity="0.95" />
    <path d="M3.5 7.3 L12 12 L12 21.4 L3.5 16.7 Z" fill="#E7E7EA" fillOpacity="0.52" />
    <path d="M20.5 7.3 L12 12 L12 21.4 L20.5 16.7 Z" fill="#E7E7EA" fillOpacity="0.30" />
  </svg>
)

/* OpenAI Codex — the OpenAI blossom logomark. */
export const CodexIcon: FC<BrandIconProps> = ({ size = 18, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#FAFAFA" className={className} aria-hidden>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
)

/*
 * Google Antigravity — the arch. Path data from LobeHub Icons (MIT,
 * github.com/lobehub/lobe-icons), the same mark components/landing/AgentMarks
 * uses. The brand's own fill is a multi-colour gradient; one neutral tone
 * keeps it beside Cursor and Codex rather than outshouting them.
 */
export const AntigravityIcon: FC<BrandIconProps> = ({ size = 18, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#E7E7EA" fillRule="evenodd" className={className} aria-hidden>
    <path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" />
  </svg>
)

/* Generic / any MCP-capable CLI — a terminal prompt. */
export const GenericAgentIcon: FC<BrandIconProps> = ({ size = 18, className }) => {
  const c = '#A1A1AA'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="3" y="4.5" width="18" height="15" rx="3" fill={c} fillOpacity="0.10" stroke={c} strokeWidth="1.5" />
      <path d="M7.4 10 L10.4 12.35 L7.4 14.7" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M12.4 14.9 H16.6" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** Agent id → logomark. Falls back to the generic terminal glyph. */
export const AGENT_ICON: Record<string, FC<BrandIconProps>> = {
  'claude-code': ClaudeIcon,
  cursor: CursorIcon,
  codex: CodexIcon,
  antigravity: AntigravityIcon,
  other: GenericAgentIcon,
}
