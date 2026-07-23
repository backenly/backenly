'use client'

/**
 * OrgSwitcher — the TopBar org chip, now a real switcher (Phase-6 gap closed).
 *
 * Solo personal org → renders exactly the static chip it replaced (name +
 * plan pill), no dropdown affordance, zero visual change for today's users.
 * More than one membership → becomes a dropdown listing every org the user
 * belongs to, with role + project count.
 *
 * Selection is persisted (localStorage `backenly.activeOrgId`) and broadcast
 * as a `backenly:org-changed` CustomEvent so org-aware surfaces (members
 * page, future org-filtered project lists) can react without prop drilling.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, Users } from 'lucide-react'

interface OrgRow {
  id: string
  name: string
  role: string
  personal: boolean
  owned: boolean
  projectCount: number
  memberCount: number
}

const STORAGE_KEY = 'backenly.activeOrgId'

export function getActiveOrgId(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(STORAGE_KEY)
}

export function OrgSwitcher({ fallbackName, plan }: { fallbackName: string; plan: string }) {
  const [orgs, setOrgs] = useState<OrgRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/org/list', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.orgs) return
        setOrgs(j.orgs)
        const stored = window.localStorage.getItem(STORAGE_KEY)
        const valid = j.orgs.find((o: OrgRow) => o.id === stored)
        setActiveId(valid ? valid.id : j.orgs.find((o: OrgRow) => o.personal)?.id ?? j.orgs[0]?.id ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const active = orgs.find((o) => o.id === activeId)
  const label = active
    ? (active.personal ? fallbackName : active.name)
    : fallbackName
  const switchable = orgs.length > 1

  const choose = (org: OrgRow) => {
    setActiveId(org.id)
    setOpen(false)
    window.localStorage.setItem(STORAGE_KEY, org.id)
    window.dispatchEvent(new CustomEvent('backenly:org-changed', { detail: { orgId: org.id } }))
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => switchable && setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-1.5 h-8 rounded-md transition-colors ${switchable ? 'hover:bg-white/[0.05]' : 'cursor-default'}`}
        aria-label={switchable ? 'Switch organization' : undefined}
      >
        <span className="text-[12.5px] text-zinc-300 truncate max-w-[140px]">{label}</span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-white/[0.05] text-zinc-400 tracking-tight">
          {plan}
        </span>
        {switchable && <ChevronDown className="w-3 h-3 text-zinc-500" />}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-[260px] bg-[#1c1d23] border border-white/[0.10] rounded-lg shadow-2xl overflow-hidden z-40">
          <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase text-zinc-600">
            Organizations
          </p>
          <div className="max-h-[280px] overflow-y-auto py-1">
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => choose(o)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.05] transition-colors"
              >
                <Users className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-zinc-200 truncate">
                    {o.personal ? `${fallbackName} (personal)` : o.name}
                  </span>
                  <span className="block text-[10.5px] text-zinc-600">
                    {o.role.toLowerCase()} · {o.projectCount} project{o.projectCount === 1 ? '' : 's'} · {o.memberCount} member{o.memberCount === 1 ? '' : 's'}
                  </span>
                </span>
                {o.id === activeId && <Check className="w-3.5 h-3.5 text-violet-300 flex-shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
