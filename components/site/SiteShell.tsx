'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { migrationPublished } from '@/components/migrate/flag'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { Icon } from '@iconify/react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, BookOpen, ChevronDown, Import, Menu, ScrollText, X, type LucideIcon } from 'lucide-react'
import { CommandBlock } from '@/components/landing-v8/CommandBlock'
import { registerSiteIcons } from '@/lib/icons/registry'
import { BrandMark } from '@/components/site/BrandMark'
import { openCookiePreferences } from '@/lib/consent'
import { ProductHuntBadge } from '@/components/site/ProductHuntBadge'
import { useUserSession } from '@/lib/hooks/useUserSession'

// Synchronously load all marketing-site icons into the Iconify cache so
// every <Icon> renders on first paint, even with no network to api.iconify.design.
registerSiteIcons()

export const ROUTES = {
  home: '/',
  signup: '/auth/signup',
  login: '/auth/login',
  app: '/app',
  pricing: '/pricing',
  // Backenly for Startups. The page and its application are Backenly Cloud's
  // (the overlay owns app/startups/**); like every marketing page here, the
  // link is only ever rendered on Cloud, since self-hosted installs redirect
  // the marketing site to /app.
  startups: '/startups',
  features: '/features',
  comparisons: '/comparisons',
  // The first docs section: the docs have no index page (2026-10-15), and
  // /docs redirects here, so links skip the hop. Keep it equal to the first
  // section of the first group in app/docs/content.ts (Connect, 2026-11-15).
  docs: '/docs/connect',
  alternatives: '/alternatives',
  privacy: '/privacy',
  terms: '/terms',
  refund: '/refund-policy',
  contact: '/contact',
  supportEmail: 'support@backenly.com',
  founder: 'https://calendly.com/adarsh-c-jose/30min',
  x: 'https://x.com/Backenly',
  linkedin: 'https://www.linkedin.com/company/117034579',
  // The flagship open-source platform repo. Must be public for this link to
  // resolve for anonymous visitors. The navbar links to it with a bare icon:
  // the star count used to be rendered beside it and was deliberately removed.
  github: 'https://github.com/backenly/backenly',
  /**
   * The Backenly community server.
   *
   * Verified against the Discord API on 2026-09-18: guild "Backenly", channel
   * #general, `expires_at: null`. The null is the point. This replaced a
   * default invite that would have died on 2026-10-18, and a dated invite sits
   * in the navbar of EVERY marketing page, so it would have rotted silently
   * with nothing in CI to catch it.
   *
   * If you ever swap this, check the replacement never expires first:
   *   curl -s https://discord.com/api/v10/invites/<code> | grep expires_at
   * Anything other than `"expires_at": null` will break the nav sitewide on a
   * date nobody has written down.
   */
  discord: 'https://discord.gg/6cHeYXDAu3',
} as const

/**
 * One switch for the Discord nav icon. Flip to false to pull it from the
 * navbar and the mobile menu at once, without hunting through the JSX.
 */
const SHOW_DISCORD = true

/**
 * What "Docs" opens (founders, 2026-11-15: the migration guide in the navbar,
 * "totally 2 things when hover in docs button", plus a changelog). The guide
 * waits for the same switch as its page and its footer link.
 */
type DocsEntry = { label: string; href: string; body: string; icon: LucideIcon }
function docsMenu(): DocsEntry[] {
  return [
    { label: 'Documentation', href: '/docs/connect', body: 'Connect your agent, then build, run and ship.', icon: BookOpen },
    ...(migrationPublished()
      ? [{ label: 'Migration guide', href: '/migrate', body: 'Move in from Supabase, Firebase or any Postgres.', icon: Import }]
      : []),
    { label: 'Changelog', href: '/changelog', body: 'What changed in Backenly, month by month.', icon: ScrollText },
  ]
}
const DOCS_PATHS = ['/docs', '/migrate', '/changelog']

const NAV_LINKS = [
  { label: 'Product', href: '/#platform', activePath: '/' },
  { label: 'Docs', href: ROUTES.docs, activePath: '/docs' },
  { label: 'Pricing', href: ROUTES.pricing, activePath: ROUTES.pricing },
  { label: 'Contact', href: ROUTES.contact, activePath: ROUTES.contact },
] as const

/* ─────────────────────────────────────────────────────────────
   Page shell: wraps any marketing page with the same chrome.
───────────────────────────────────────────────────────────── */
/**
 * Moves focus to the page's own <main>, rather than relying on the href alone.
 *
 * A bare `href="#main-content"` only works if something on the page carries
 * that id, and each marketing page renders its own <main>; wrapping children
 * here to hold the id instead is not an option, because a `display: contents`
 * wrapper cannot take focus (the hash updates and the caret stays in the nav)
 * and a real wrapper would insert a box into the shell's flex column.
 *
 * So the anchor keeps the href for the no-JS case (the landing page carries
 * the matching id) and this handler does the actual focus move everywhere.
 * `preventScroll` because <main> starts at the top of the document already.
 */
function skipToContent(event: React.MouseEvent<HTMLAnchorElement>) {
  const main = document.querySelector('main')
  if (!main) return

  event.preventDefault()
  main.setAttribute('tabindex', '-1')
  main.focus({ preventScroll: true })
}

/**
 * Scrolling on the public site is the browser's own, like Supabase, Vercel and
 * Linear: no smooth-scroll library. Lenis used to drive it, gliding every wheel
 * tick for 1.5s from requestAnimationFrame on the main thread, which is the
 * thread a low-memory laptop has least of; native scrolling runs on the
 * compositor and keeps up while the page's JavaScript is busy.
 *
 * What stays smooth is the jump to an in-page anchor: html carries
 * `scroll-behavior: smooth` (app/globals.css), and the browser animates that
 * natively. The same rule would also animate every page change back to the
 * top, because Next 16 resets scroll-behavior during a route change only when
 * <html> has data-scroll-behavior="smooth". This sets it while a public page is
 * mounted, so page changes here land instantly and the console keeps its own
 * behaviour. A layout effect, not a passive one: on a client navigation into
 * the site it must be in place before the router's scroll, which runs in the
 * layout phase, in an ancestor of this component.
 */
function useInstantPageChanges() {
  useLayoutEffect(() => {
    const html = document.documentElement
    html.dataset.scrollBehavior = 'smooth'
    return () => {
      delete html.dataset.scrollBehavior
    }
  }, [])
}

/**
 * `navOverlay` (opt-in, the landing only): the bar starts clear over the page's
 * first section and takes its usual frosted fill once the page scrolls. Every
 * other page renders the bar exactly as before.
 *
 * `footerLit` (opt-in, the landing only): the last section's light runs on
 * behind the footer, so the footer drops its top rule and takes brighter text,
 * and the page clips that light at its end. Every other page renders the
 * footer exactly as before.
 */
export function SiteShell({ children, navOverlay = false, footerLit = false }: { children: React.ReactNode; navOverlay?: boolean; footerLit?: boolean }) {
  useInstantPageChanges()
  return (
    <div>
      <div
        // overflow-x-CLIP, not hidden. `hidden` makes this wrapper a scroll
        // container (overflow-y computes to auto), and a sticky descendant
        // then sticks to a box that never scrolls, i.e. never sticks at all:
        // every `sticky` on the marketing pages was silently inert. `clip`
        // crops the same overflow without creating a scroll container.
        className="bg-[#08090a] text-white antialiased relative min-h-screen overflow-x-clip selection:bg-violet-500/30 selection:text-white font-light flex flex-col items-center"
        style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
      >
        {/* With footerLit the column carries the page colour too: the closing's grain blends within this layer, and over a clear
            backdrop it would only grey the footer. */}
        <div className={`relative w-full min-h-screen flex flex-col z-20 ${footerLit ? 'overflow-y-clip bg-[#08090a]' : ''}`}>
          {/* First tab stop on every marketing page: lets a keyboard or screen
              reader user jump the nav instead of walking it on each page.
              Visually hidden until focused. */}
          <a
            href="#main-content"
            onClick={skipToContent}
            // The padding carries `focus:` too: `not-sr-only` resets padding
            // to 0, so an unprefixed px-4/py-2 is wiped the moment the link
            // becomes visible and it renders as bare text on black.
            className="sr-only rounded-md bg-white text-sm font-semibold text-black focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:px-4 focus:py-2"
          >
            Skip to content
          </a>
          <NavBar overlay={navOverlay} />
          {children}
          <SiteFooter lit={footerLit} />
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Nav
───────────────────────────────────────────────────────────── */
let navHasEntered = false

export function NavBar({ overlay = false }: { overlay?: boolean } = {}) {
  // Overlay: clear while the page is at its top, the usual fill after. An
  // observer on an 8px marker at the top of the page answers, so scrolling
  // never reads layout (reading scrollY forces one when the page is busy).
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    if (!overlay) return
    const mark = document.createElement('div')
    mark.setAttribute('aria-hidden', 'true')
    mark.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none;visibility:hidden'
    document.body.prepend(mark)
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting))
    io.observe(mark)
    return () => {
      io.disconnect()
      mark.remove()
    }
  }, [overlay])
  const [mobileOpen, setMobileOpen] = useState(false)
  // The link group and the buttons drop their entrance once it has played. A
  // finished `nav-drop` holds its end state, and Chrome's full-page capture
  // (DevTools' "Capture full size screenshot", Playwright's fullPage) re-runs
  // these nested, delayed animations from their first frame, so the links came
  // out blank in those captures while the live page was fine. The entrance
  // often ends before React hydrates, so this waits on the animations' own
  // `finished` (already resolved by then) rather than on animationend.
  // Every marketing page wraps itself in SiteShell, so the bar remounts on each
  // client navigation; it drops in once per page load (module flag: false
  // again only after a full load, so hydration always matches the server).
  const [navEntered, setNavEntered] = useState(() => navHasEntered)
  useEffect(() => {
    navHasEntered = true
  }, [])
  const navGroupRef = useRef<HTMLElement>(null)
  const authGroupRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const animations = [navGroupRef.current, authGroupRef.current].flatMap((el) => el?.getAnimations?.() ?? [])
    Promise.all(animations.map((a) => a.finished))
      .then(() => {
        if (live) setNavEntered(true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const navDrop = navEntered ? '' : 'nav-drop '
  const pathname = usePathname()
  const reduceMotion = useSettledReducedMotion()
  const { isLoggedIn } = useUserSession()

  useEffect(() => {
    if (!mobileOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mobileOpen])

  return (
    // The entrance is CSS (`nav-drop`, app/globals.css), as on the landing
    // hero: as framer `initial` props the bar was rendered at opacity 0 and
    // stayed blank until React hydrated, on every marketing page.
    <header
      className={
        overlay
          ? `nav-drop sticky top-0 z-40 w-full border-b transition-[background-color,border-color] duration-300 ${
              scrolled || mobileOpen
                ? 'border-white/[0.07] bg-[#08090a]/80 backdrop-blur-xl backdrop-saturate-150'
                : 'border-transparent bg-transparent'
            }`
          : 'nav-drop sticky top-0 z-40 w-full border-b border-white/[0.07] bg-[#08090a]/80 backdrop-blur-xl backdrop-saturate-150'
      }
    >
      {/* Container tracks the landing's 100rem sections so the logo sits on
          the same left edge as the headline below it. */}
      <div className="mx-auto flex h-[68px] w-full max-w-[100rem] items-center justify-between px-5 sm:px-6">
        <motion.div whileHover={{ y: -1 }} whileTap={{ scale: 0.985 }}>
          <Link
            href={ROUTES.home}
            className="flex items-center gap-2.5 text-white transition-colors hover:text-zinc-200"
            onClick={() => setMobileOpen(false)}
            aria-label="Backenly"
          >
            <BrandMark size={28} />
            <span className="text-[19px] font-semibold tracking-[-0.02em]">Backenly</span>
          </Link>
        </motion.div>

        {/* Everything except the logo lives on the right, like the benchmark:
            plain text links (the floating pill container is gone), then the
            auth cluster. justify-between + one right group = right-aligned. */}
        <div className="hidden items-center gap-6 lg:flex">
          <nav
            // 16px, not 15px. Measured against the field on 2026-09-18:
            // Linear, Stripe, Supabase and Neon all set their marketing nav at
            // 16px. At 15px, next to an 18px wordmark, these read as secondary
            // captions rather than as the site's primary navigation.
            ref={navGroupRef}
            className={`${navDrop}flex items-center gap-0.5 text-[15px] font-medium tracking-[-0.006em] text-zinc-400 [--enter-delay:80ms] [--nav-drop:-8px]`}
          >
            {NAV_LINKS.map((link) =>
              link.label === 'Docs' ? (
                <DocsMenu key={link.label} pathname={pathname} />
              ) : (
                <DesktopNavLink key={link.label} link={link} pathname={pathname} />
              ),
            )}
          </nav>

          {/* Desktop auth buttons */}
          <div ref={authGroupRef} className={`${navDrop}flex items-center gap-4 [--enter-delay:140ms] [--nav-drop:-8px]`}>
          <a
            href={ROUTES.github}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Backenly on GitHub"
            className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-white"
          >
            <Icon icon="ri:github-fill" width={17} />
          </a>
          {SHOW_DISCORD && (
            <a
              href={ROUTES.discord}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Backenly on Discord"
              className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-white"
            >
              <Icon icon="ri:discord-fill" width={17} />
            </a>
          )}
          <span className="h-6 w-px bg-white/[0.12]" aria-hidden />
          <Link
            href={isLoggedIn ? ROUTES.app : ROUTES.signup}
            className="inline-flex h-9 items-center rounded-lg bg-white px-4 text-[14px] font-semibold tracking-[-0.01em] text-black transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            {isLoggedIn ? 'Console' : 'Sign up'}
          </Link>
          </div>
        </div>

        {/* Mobile hamburger */}
        <motion.button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          whileTap={{ scale: 0.94 }}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white lg:hidden"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </motion.button>
      </div>

      {/* Mobile menu panel */}
      <AnimatePresence initial={false}>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(8px)' }}
            transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 right-0 top-[68px] z-50 mx-4 rounded-lg border border-white/[0.08] bg-[#050505] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl lg:hidden"
          >
            <div className="flex flex-col gap-1 px-5 py-5">
              {NAV_LINKS.map((link, index) => (
                <motion.div
                  key={link.label}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.24, delay: reduceMotion ? 0 : index * 0.035, ease: [0.16, 1, 0.3, 1] }}
                >
                  <MobileLink
                    href={link.href}
                    active={isLinkActive(link.activePath, pathname)}
                    onClose={() => setMobileOpen(false)}
                  >
                    {link.label}
                  </MobileLink>
                  {link.label === 'Docs' &&
                    docsMenu()
                      .slice(1)
                      .map((entry) => (
                        <Link
                          key={entry.href}
                          href={entry.href}
                          onClick={() => setMobileOpen(false)}
                          className={`flex items-center gap-3 rounded-lg py-3 pl-8 pr-4 text-sm transition-colors ${
                            isLinkActive(entry.href, pathname) ? 'bg-white/[0.1] text-white' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-white'
                          }`}
                        >
                          <entry.icon aria-hidden className="h-[15px] w-[15px] text-zinc-500" strokeWidth={1.75} />
                          {entry.label}
                        </Link>
                      ))}
                </motion.div>
              ))}

              <a
                href={ROUTES.github}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-between rounded-lg px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                <span className="flex items-center gap-2">GitHub</span>
                <Icon icon="solar:arrow-right-up-linear" width={13} className="text-zinc-500" />
              </a>

              {SHOW_DISCORD && (
                <a
                  href={ROUTES.discord}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center justify-between rounded-lg px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-white"
                >
                  <span className="flex items-center gap-2">Discord</span>
                  <Icon icon="solar:arrow-right-up-linear" width={13} className="text-zinc-500" />
                </a>
              )}

              <Link
                href={isLoggedIn ? ROUTES.app : ROUTES.signup}
                onClick={() => setMobileOpen(false)}
                className="mt-4 flex items-center justify-center rounded-lg bg-white py-3 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
              >
                {isLoggedIn ? 'Console' : 'Sign up'}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}

/* Nav helpers */
function isLinkActive(activePath: string | undefined, pathname: string) {
  if (!activePath) return false
  if (activePath === '/') return pathname === '/'
  return pathname === activePath || pathname.startsWith(`${activePath}/`)
}

/**
 * "Docs" as a disclosure (WAI-ARIA's navigation-menu pattern): a button that
 * shows a panel of links. It opens on hover where there is a fine pointer (after
 * a short pause, so a pointer passing over it does not flash it open), and on
 * click or Enter anywhere; Escape, a click outside, or moving focus away closes
 * it.
 *
 * The panel (founders, 2026-11-15: "make the docs popup hover more
 * professional", after Blaxel's) spans the header's own width, so its edges
 * line up with the logo and the Sign up button: the entries as type in
 * columns, a quick start with the one command a developer runs, and a line to
 * start free. The wrapper is not positioned, so the panel is placed by the
 * sticky header itself.
 */
function DocsMenu({ pathname }: { pathname: string }) {
  // Open on the page it was opened on, so moving to another page closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === pathname
  const setOpen = (next: boolean | ((was: boolean) => boolean)) =>
    setOpenOn((was) => ((typeof next === 'function' ? next(was === pathname) : next) ? pathname : null))
  const panelId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef(0)
  const reduceMotion = useSettledReducedMotion()
  const entries = docsMenu()
  const active = DOCS_PATHS.some((path) => isLinkActive(path, pathname))
  const { isLoggedIn } = useUserSession()

  const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  const show = (delay = 0) => {
    window.clearTimeout(closeTimer.current)
    if (delay) closeTimer.current = window.setTimeout(() => setOpen(true), delay)
    else setOpen(true)
  }
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 160)
  }

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpenOn(null)
      buttonRef.current?.focus()
    }
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenOn(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => finePointer() && show(open ? 0 : 70)}
      onMouseLeave={() => finePointer() && hideSoon()}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={[
          'inline-flex items-center gap-[5px] rounded-md px-3 py-2 transition-colors duration-200',
          active || open ? 'text-white' : 'text-zinc-400 hover:text-white',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
        ].join(' ')}
      >
        Docs
        <ChevronDown aria-hidden className={`h-[13px] w-[13px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: reduceMotion ? 0 : 0.1 } }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-0 top-full z-50 pt-[10px]"
          >
            <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-6">
              <div className="overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f] shadow-[0_32px_80px_-28px_rgba(0,0,0,0.95)]">
                <div className="grid grid-cols-[minmax(0,1fr)_400px]">
                  <ul className={`grid content-start gap-[4px] p-[10px] ${entries.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {entries.map(({ label, href, body, icon: EntryIcon }) => (
                      <li key={href}>
                        <Link
                          href={href}
                          onClick={() => setOpen(false)}
                          aria-current={isLinkActive(href, pathname) ? 'page' : undefined}
                          className="group flex h-full flex-col rounded-[8px] px-[18px] py-[18px] transition-colors duration-150 hover:bg-white/[0.035] focus-visible:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                        >
                          <EntryIcon aria-hidden className="h-[17px] w-[17px] text-zinc-400 transition-colors duration-150 group-hover:text-white" strokeWidth={1.75} />
                          <span className="mt-[16px] flex items-center gap-[6px] text-[15px] font-medium tracking-[-0.01em] text-white">
                            {label}
                            <ArrowRight
                              aria-hidden
                              className="h-[14px] w-[14px] text-zinc-500 transition-[transform,color] duration-150 group-hover:translate-x-[2px] group-hover:text-zinc-200"
                            />
                          </span>
                          <span className="mt-[6px] text-[14px] font-normal leading-[1.55] text-zinc-400">{body}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>

                  <div className="border-l border-white/[0.08] bg-white/[0.012] px-[24px] py-[26px] xl:px-[28px]">
                    <p className="text-[13px] font-normal text-faint">Quick start</p>
                    <p className="mt-[10px] text-[15px] font-medium tracking-[-0.01em] text-white">Connect your agent</p>
                    <p className="mt-[6px] text-[14px] font-normal leading-[1.55] text-zinc-400">
                      Run it in your project folder. It asks for your project&rsquo;s MCP key, then prints the setup for your agent.
                    </p>
                    <CommandBlock className="mt-[18px] h-[44px] shadow-none" />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-6 border-t border-white/[0.08] px-[28px] py-[14px]">
                  <p className="text-[14px] font-normal text-zinc-400">
                    {isLoggedIn ? (
                      <>
                        <span className="font-medium text-white">Your console</span>
                        <span className="ml-[10px]">Your projects are where you left them.</span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-white">Get started</span>
                        <span className="ml-[10px]">One free project, kept permanently. No credit card.</span>
                      </>
                    )}
                  </p>
                  <Link
                    href={isLoggedIn ? ROUTES.app : ROUTES.signup}
                    onClick={() => setOpen(false)}
                    className="group inline-flex h-[34px] shrink-0 items-center gap-[6px] rounded-[6px] bg-white px-[14px] text-[13.5px] font-medium text-black transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c0f]"
                  >
                    {isLoggedIn ? 'Open console' : 'Start free'}
                    <ArrowRight aria-hidden className="h-[14px] w-[14px] transition-transform duration-150 group-hover:translate-x-[2px]" />
                  </Link>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DesktopNavLink({
  link,
  pathname,
}: {
  link: (typeof NAV_LINKS)[number]
  pathname: string
}) {
  const active = isLinkActive(link.activePath, pathname)
  // The current item is marked by CONTRAST, not by a filled pill.
  //
  // This used to render a `bg-white/[0.11]` rounded-full slab behind the
  // active label, sliding between items on a `layoutId` spring. It was nicely
  // built and it was the wrong idiom: a filled segmented-control pill belongs
  // to an app tab bar, not a marketing nav. Checked against the field on
  // 2026-09-18 and none of Linear, Stripe, Supabase, Clerk or Neon put a
  // filled active state in their marketing nav; every one of them separates
  // current from the rest with text colour alone.
  //
  // It also mis-fired here: "Product" carries `activePath: '/'`, so the pill
  // sat permanently on the home page, highlighting what is only an in-page
  // anchor.
  const classes = [
    'rounded-md px-3 py-2 transition-colors duration-200',
    active ? 'text-white' : 'text-zinc-400 hover:text-white',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
  ].join(' ')
  const content = <span>{link.label}</span>

  if (link.href.startsWith('mailto')) {
    return (
      <a href={link.href} className={classes}>
        {content}
      </a>
    )
  }

  return (
    <Link href={link.href} className={classes}>
      {content}
    </Link>
  )
}

function MobileLink({
  href,
  active,
  onClose,
  children,
}: {
  href: string
  active: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const classes = [
    'flex items-center justify-between rounded-lg px-4 py-3 text-sm transition-colors',
    active ? 'bg-white/[0.1] text-white' : 'text-zinc-300 hover:bg-white/[0.05] hover:text-white',
  ].join(' ')

  if (href.startsWith('mailto')) {
    return (
      <a href={href} onClick={onClose} className={classes}>
        {children}
        <Icon icon="solar:arrow-right-up-linear" width={13} className="text-zinc-500" />
      </a>
    )
  }

  return (
    <Link
      href={href}
      onClick={onClose}
      className={classes}
    >
      {children}
      <Icon icon="solar:alt-arrow-down-linear" width={12} className="-rotate-90 text-zinc-600" />
    </Link>
  )
}

/* ─────────────────────────────────────────────────────────────
   Footer
───────────────────────────────────────────────────────────── */
export function SiteFooter({ lit = false }: { lit?: boolean } = {}) {
  const product = [
    { label: 'Features', href: ROUTES.features },
    { label: 'Pricing', href: ROUTES.pricing },
    { label: 'Startup program', href: ROUTES.startups },
    { label: 'Comparisons', href: ROUTES.comparisons },
    { label: 'Alternatives', href: ROUTES.alternatives },
  ]
  const developers = [
    { label: 'GitHub', href: ROUTES.github },
    { label: 'MCP server', href: '/mcp' },
    { label: 'CLI', href: 'https://www.npmjs.com/package/@backenly/cli' },
    { label: 'Agent skill', href: '/skill.md' },
    { label: 'llms.txt', href: '/llms.txt' },
    { label: 'Documentation', href: ROUTES.docs },
    // The migration guide, once moving a project in is published (components/migrate/flag.ts).
    ...(migrationPublished() ? [{ label: 'Migration guide', href: '/migrate' }] : []),
    { label: 'Changelog', href: '/changelog' },
  ]
  const company = [
    { label: 'Contact', href: ROUTES.contact },
    { label: 'Talk to the founders', href: ROUTES.founder },
    { label: 'Privacy Policy', href: ROUTES.privacy },
    { label: 'Terms of Service', href: ROUTES.terms },
    { label: 'Refund Policy', href: ROUTES.refund },
  ]

  return (
    <footer className={`relative z-20 mt-auto pb-8 pt-14 sm:pt-16 ${lit ? '' : 'border-t border-white/[0.07]'}`}>
      {/* 88rem matches the landing sections, so the footer's left edge lines
          up with the content above it. Subpages run narrower content inside
          the same footer width, which reads fine; a misaligned landing edge
          does not. */}
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-6">
        <div className="mb-12 grid grid-cols-1 gap-10 sm:grid-cols-2 md:mb-14 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:gap-8">
          <div className="flex flex-col gap-4 sm:col-span-2 lg:col-span-1">
            <Link href={ROUTES.home} className="flex items-center gap-2.5 text-white">
              <BrandMark size={26} decorative={lit} />
              <span className="text-base font-semibold">Backenly</span>
            </Link>
            {/* Cut from three sentences to one on 2026-09-18. The old blurb
                restated the hero ("Your coding agent builds it. Backenly keeps
                it running, every change governed, verified, and reversible")
                to a reader who had already scrolled the whole page to get
                here, and the positioning line is already in the bar below.
                What is left is the one fact a footer should carry: the one a
                stranger can go and check. */}
            <p className={`max-w-xs text-sm leading-6 ${lit ? 'text-zinc-300' : 'text-zinc-400'}`}>
              Open source under Apache-2.0.
            </p>
            <div className={`mt-1 flex items-center gap-3 ${lit ? 'text-zinc-300' : 'text-zinc-500'}`}>
              <a
                href={ROUTES.github}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Backenly on GitHub"
                className="transition-colors hover:text-white"
              >
                <Icon icon="ri:github-fill" width={17} />
              </a>
              {/* Same order as the navbar: GitHub, then Discord. Behind the
                  same switch, so one flag governs all three placements. */}
              {SHOW_DISCORD && (
                <a
                  href={ROUTES.discord}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Backenly on Discord"
                  className="transition-colors hover:text-white"
                >
                  <Icon icon="ri:discord-fill" width={17} />
                </a>
              )}
              <a
                href={ROUTES.x}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Backenly on X"
                className="transition-colors hover:text-white"
              >
                <Icon icon="ri:twitter-x-line" width={17} />
              </a>
              <a
                href={ROUTES.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Backenly on LinkedIn"
                className="transition-colors hover:text-white"
              >
                <Icon icon="ri:linkedin-fill" width={17} />
              </a>
            </div>
            <ProductHuntBadge className="mt-2" />
          </div>
          <FooterCol title="Product" links={product} lit={lit} />
          <FooterCol title="Developers" links={developers} lit={lit} />
          <FooterCol title="Company" links={company} lit={lit} />
        </div>

        <div className={`flex flex-col items-center justify-between gap-4 border-t pt-7 md:flex-row ${lit ? 'border-white/[0.12]' : 'border-white/[0.08]'}`}>
          <p className={`flex flex-wrap items-center justify-center gap-x-[16px] gap-y-1 text-xs ${lit ? 'text-zinc-400' : 'text-zinc-600'}`}>
            <span>&copy; {new Date().getFullYear()} Backenly. All rights reserved.</span>
            <button
              type="button"
              onClick={openCookiePreferences}
              className={`rounded-[3px] underline decoration-current/30 underline-offset-[3px] transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${lit ? '' : 'text-zinc-500'}`}
            >
              Cookie preferences
            </button>
          </p>
          <p className={`text-xs ${lit ? 'text-zinc-400' : 'text-zinc-600'}`}>The autonomous backend platform</p>
        </div>
      </div>
    </footer>
  )
}

function FooterCol({ title, links, lit = false }: { title: string; links: { label: string; href: string }[]; lit?: boolean }) {
  return (
    <div>
      {/*
        h2, not h4. These are the top-level groupings inside the footer landmark,
        and every marketing page runs h1 → h2 sections above them, so an h4 here
        produced an h2 → h4 skip on every page on the site. The level is the only
        thing that changed; the type scale is set by the classes, not the tag.
      */}
      <h2 className={`mb-4 text-[14px] font-medium tracking-[-0.006em] ${lit ? 'text-white' : 'text-zinc-200'}`}>
        {title}
      </h2>
      <ul className={`space-y-2.5 text-sm ${lit ? 'text-zinc-300' : 'text-zinc-400'}`}>
        {links.map((l) => {
          const external = l.href.startsWith('http') || l.href.startsWith('mailto')
          const plainFile = l.href.endsWith('.md') || l.href.endsWith('.txt')
          return (
            <li key={l.label}>
              {external || plainFile ? (
                <a
                  href={l.href}
                  target={external ? '_blank' : undefined}
                  rel={external ? 'noopener noreferrer' : undefined}
                  className="transition-colors hover:text-white"
                >
                  {l.label}
                </a>
              ) : (
                <Link href={l.href} className="transition-colors hover:text-white">
                  {l.label}
                </Link>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
