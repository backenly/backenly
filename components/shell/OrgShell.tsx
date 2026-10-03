'use client'

/**
 * OrgShell: the account-level frame (IA restructure §5).
 *
 * Projects, Usage, Members, Billing and Settings, in the same frame as the
 * project workspace (ConsoleFrame) so the two levels read as one product. The
 * bar here carries no project switcher and no environment, because there is no
 * project in scope: brand, the account, search, and the account menu.
 */

import { type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { FolderKanban, Gauge, Users, CreditCard, Settings } from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import {
  AccountMenu,
  AccountScope,
  BrandHome,
  ConsoleBar,
  ConsoleFrame,
  Crumb,
  MobileNavButton,
  NavGroup,
  NavItem,
  SearchTrigger,
  SidebarNav,
} from './ConsoleChrome'

/**
 * Members and Billing are Cloud surfaces: their pages and APIs live in the
 * private overlay, so a public build that listed them would offer a menu item
 * routing to a page it does not contain. CLOUD_CONTROL_PLANE is a build-time
 * constant that is true exactly when those files are present. It gates
 * PRESENTATION only; every access decision stays server-side.
 */
const NAV = [
  { id: 'projects', title: 'Projects',          icon: FolderKanban, href: '/app',          match: (p: string) => p === '/app' || p === '/app/' },
  // Usage is a billing-cycle surface: it reads /api/billing/usage (overlay-only)
  // and renders consumption against plan ceilings. A self-hosted deployment has
  // no billing cycle and no ceilings — every self-host entitlement is null —
  // so the page could only ever show bars against infinity, and in the public
  // build it showed "Could not load usage data" because its endpoint is absent.
  ...(CLOUD_CONTROL_PLANE
    ? ([
        { id: 'usage',    title: 'Usage',             icon: Gauge,        href: '/app/usage',    match: (p: string) => p.startsWith('/app/usage') },
        { id: 'members',  title: 'Members',           icon: Users,        href: '/app/members',  match: (p: string) => p.startsWith('/app/members') },
        { id: 'billing',  title: 'Billing', icon: CreditCard,   href: '/app/billing',  match: (p: string) => p.startsWith('/app/billing') },
      ] as const)
    : ([] as const)),
  // HIDDEN 2026-07-19 — referral program parked for now. Backend (signup ?ref=,
  // /api/referral, credit grants) still works; to restore, add a row here with
  // the Gift icon, and REFERRAL_HIDDEN in app/app/referral/page.tsx.
] as const

export function OrgShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? ''
  const settingsActive = pathname.startsWith('/app/settings')

  const bar = (
    <ConsoleBar>
      <MobileNavButton />
      <BrandHome />
      <Crumb />
      {/* The same scope chip the project bar shows: the organization (a
          switcher on Cloud) and the account's real plan. */}
      <AccountScope />
      <div className="ml-auto flex items-center gap-1.5">
        <SearchTrigger />
        <AccountMenu />
      </div>
    </ConsoleBar>
  )

  const sidebar = (
    <SidebarNav
      footer={
        <ul>
          <NavItem href="/app/settings" icon={Settings} label="Settings" active={settingsActive} />
        </ul>
      }
    >
      <NavGroup first>
        {NAV.map((item) => (
          <NavItem key={item.id} href={item.href} icon={item.icon} label={item.title} active={item.match(pathname)} />
        ))}
      </NavGroup>
    </SidebarNav>
  )

  return (
    <ConsoleFrame bar={bar} sidebar={sidebar} drawerLabel="Account navigation">
      {children}
    </ConsoleFrame>
  )
}
