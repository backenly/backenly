/**
 * The kind icon each Autonomy row carries in its IconWell (the founder's call,
 * 2026-11-16: the spanner and the bin were clearer than a state dot). One map,
 * so Overview's "Waiting on you" and Autonomy show a row the same way.
 *
 *   a fix Backenly made               Wrench
 *   an agent call that removes data   Trash2
 *   a restore or rollback             History
 *   merging a branch                  GitMerge
 *   any other agent call              Database
 *   an architecture change            Layers
 *   a finding, by what it is about    ShieldAlert / Gauge / Activity
 */

import { Activity, Database, Gauge, GitMerge, History, Layers, ShieldAlert, Trash2, Wrench, type LucideIcon } from 'lucide-react'
import type { FindingCategory } from '@/lib/core/finding-groups'

/** Tools whose approval removes something. */
export const REMOVES = /^(drop_|delete_|truncate_|revoke_|remove_|discard_|disable_|block_)/

export const CATEGORY_ICON: Record<FindingCategory, LucideIcon> = {
  security: ShieldAlert,
  performance: Gauge,
  reliability: Activity,
}

export function findingIcon(category: FindingCategory | null | undefined): LucideIcon {
  return (category && CATEGORY_ICON[category]) || Activity
}

export function approvalIcon(tool: string): LucideIcon {
  if (tool === 'revert_schema_change' || tool === 'rollback_deploy') return History
  if (tool === 'merge_branch') return GitMerge
  if (REMOVES.test(tool)) return Trash2
  return Database
}

export const FIX_ICON = Wrench
export const ARCHITECTURE_ICON = Layers
