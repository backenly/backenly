/**
 * Whether the project is published, in one fact: the Deploy page's header,
 * and Overview's header (project decision 10, 2026-11-16).
 *
 *   ●  v5 published Nov 14      LIVE, with its latest version
 *   ●  Published                LIVE, with no version on record (a project published before versions)
 *   ◐  Publishing               a publish is running
 *   ✕  Publish failed           the last publish failed; no version was recorded
 *   ○  Not published            never published
 *
 * The version and its moment come from GET /api/projects/[id]/rollback
 * (versions[0], newest first), which is the publish itself; the project's
 * status from GET /api/projects/[id]. Pure, so a server or a test can call it.
 * On screen, render `at` with <Time mode="date"> so the full moment shows on
 * hover; `text` is the same fact as one string (titles, aria).
 */

import type { GlyphState } from '@/components/inspector/kit'
import { formatTime, type Moment } from '@/components/console/format'

export interface PublishFact {
  glyph: GlyphState
  /** The state in words, for screen readers: "Published", "Not published", "Publishing", "Publish failed". */
  label: string
  /** The fact as one string: "v5 published Nov 14". */
  text: string
  /** The latest published version, when the fact names one. */
  version: number | null
  /** When it was published, when the fact names a version. */
  at: string | null
  /** White while publishing and when it failed: a word the person should read. Faint otherwise. */
  tone: 'neutral' | 'attention' | 'danger'
}

export interface PublishFactInput {
  /** Project.projectStatus: PRIVATE | DEPLOYING | LIVE | FAILED. */
  projectStatus?: string | null
  /** The newest published version (versions[0] of GET …/rollback), if any. */
  latest?: { version: number; publishedAt: string } | null
}

export function publishFact({ projectStatus, latest }: PublishFactInput, opts: { now?: Moment } = {}): PublishFact {
  if (projectStatus === 'DEPLOYING') {
    return { glyph: 'busy', label: 'Publishing', text: 'Publishing', version: null, at: null, tone: 'attention' }
  }
  if (projectStatus === 'FAILED') {
    return { glyph: 'failed', label: 'Publish failed', text: 'Publish failed', version: null, at: null, tone: 'danger' }
  }
  if (projectStatus === 'LIVE') {
    if (latest && Number.isFinite(latest.version) && latest.publishedAt) {
      const date = formatTime(latest.publishedAt, 'date', opts)
      return {
        glyph: 'live',
        label: 'Published',
        text: date ? `v${latest.version} published ${date}` : `v${latest.version} published`,
        version: latest.version,
        at: latest.publishedAt,
        tone: 'neutral',
      }
    }
    return { glyph: 'live', label: 'Published', text: 'Published', version: null, at: null, tone: 'neutral' }
  }
  return { glyph: 'idle', label: 'Not published', text: 'Not published', version: null, at: null, tone: 'neutral' }
}
