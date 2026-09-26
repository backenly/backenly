'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { Icon } from '@iconify/react'
import { AnimatePresence, motion } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { registerSiteIcons } from '@/lib/icons/registry'
import { BrandMark } from '@/components/site/BrandMark'
import { SmoothScroll } from '@/components/site/SmoothScroll'
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
  features: '/features',
  useCases: '/use-cases',
  comparisons: '/comparisons',
  resources: '/resources',
  alternatives: '/alternatives',
  privacy: '/privacy',
  terms: '/terms',
  refund: '/refund-policy',
  contact: '/contact',
  supportEmail: 'support@backenly.com',
  founder: 'https://calendly.com/adarsh-c-jose/30min',
  x: 'https://x.com/Backenly',
  linkedin: 'https://www.linkedin.com/company/117034579',
  /**
   * Product Hunt.
   *
   * INTERIM AND DELIBERATE: this is Product Hunt's own home page, not a
   * Backenly page. Founder's call, so the hero launch chip has somewhere
   * valid to point while Backenly's upcoming page does not exist yet.
   * It is not a defect and does not block a release.
   *
   * Swap for Backenly's coming-soon URL once it exists
   * (producthunt.com/products/<slug>), then for the live post URL on launch
   * day. This constant is the ONLY reference in the codebase.
   */
  productHunt: 'https://www.producthunt.com',
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

const NAV_LINKS = [
  { label: 'Product', href: '/#capabilities', activePath: '/' },
  { label: 'Resources', href: ROUTES.resources, activePath: ROUTES.resources },
  { label: 'Use cases', href: ROUTES.useCases, activePath: ROUTES.useCases },
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

export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SmoothScroll />
      <div
        className="bg-black text-white antialiased relative min-h-screen overflow-x-hidden selection:bg-violet-500/30 selection:text-white font-light flex flex-col items-center"
        style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
      >
        <div className="relative w-full min-h-screen flex flex-col z-20">
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
          <NavBar />
          {children}
          <SiteFooter />
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Nav
───────────────────────────────────────────────────────────── */
export function NavBar() {
  const [mobileOpen, setMobileOpen] = useState(false)
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
    <motion.header
      initial={{ opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-black/[0.88] backdrop-blur-xl"
    >
      {/* Container tracks the landing's 100rem sections so the logo sits on
          the same left edge as the headline below it. */}
      <div className="mx-auto flex h-[76px] w-full max-w-[100rem] items-center justify-between px-5 sm:px-6">
        <motion.div whileHover={{ y: -1 }} whileTap={{ scale: 0.985 }}>
          <Link
            href={ROUTES.home}
            className="flex items-center gap-2.5 text-white transition-colors hover:text-zinc-200"
            onClick={() => setMobileOpen(false)}
            aria-label="Backenly"
          >
            <BrandMark size={28} />
            <span className="text-xl font-semibold">Backenly</span>
          </Link>
        </motion.div>

        {/* Everything except the logo lives on the right, like the benchmark:
            plain text links (the floating pill container is gone), then the
            auth cluster. justify-between + one right group = right-aligned. */}
        <div className="hidden items-center gap-6 lg:flex">
          <motion.nav
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.7, delay: reduceMotion ? 0 : 0.08, ease: [0.16, 1, 0.3, 1] }}
            // 16px, not 15px. Measured against the field on 2026-09-18:
            // Linear, Stripe, Supabase and Neon all set their marketing nav at
            // 16px. At 15px, next to an 18px wordmark, these read as secondary
            // captions rather than as the site's primary navigation.
            className="flex items-center gap-1 text-[16px] font-medium text-zinc-400"
          >
            {NAV_LINKS.map((link) => (
              <DesktopNavLink key={link.label} link={link} pathname={pathname} />
            ))}
          </motion.nav>

          {/* Desktop auth buttons */}
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.7, delay: reduceMotion ? 0 : 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-4"
          >
          <a
            href={ROUTES.github}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Backenly on GitHub"
            className="group flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-white"
          >
            <Icon icon="ri:github-fill" width={17} />
          </a>
          {SHOW_DISCORD && (
            <a
              href={ROUTES.discord}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Backenly on Discord"
              className="group flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:border-white/[0.16] hover:text-white"
            >
              <Icon icon="ri:discord-fill" width={17} />
            </a>
          )}
          <span className="h-6 w-px bg-white/[0.12]" aria-hidden />
          <Link
            href={isLoggedIn ? ROUTES.app : ROUTES.signup}
            className="rounded-full bg-white px-5 py-2.5 text-[15px] font-semibold text-black transition-colors hover:bg-zinc-200"
          >
            {isLoggedIn ? 'Console' : 'Sign up'}
          </Link>
          </motion.div>
        </div>

        {/* Mobile hamburger */}
        <motion.button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          whileTap={{ scale: 0.94 }}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white lg:hidden"
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
            className="absolute left-0 right-0 top-[76px] z-50 mx-4 rounded-lg border border-white/[0.08] bg-[#050505] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl lg:hidden"
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
                </motion.div>
              ))}

              <a
                href={ROUTES.github}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="flex items-center justify-between rounded-full px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-white"
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
                  className="flex items-center justify-between rounded-full px-4 py-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-white"
                >
                  <span className="flex items-center gap-2">Discord</span>
                  <Icon icon="solar:arrow-right-up-linear" width={13} className="text-zinc-500" />
                </a>
              )}

              <Link
                href={isLoggedIn ? ROUTES.app : ROUTES.signup}
                onClick={() => setMobileOpen(false)}
                className="mt-4 flex items-center justify-center rounded-full bg-white py-3 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
              >
                {isLoggedIn ? 'Console' : 'Sign up'}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  )
}

/* Nav helpers */
function isLinkActive(activePath: string | undefined, pathname: string) {
  if (!activePath) return false
  if (activePath === '/') return pathname === '/'
  return pathname === activePath || pathname.startsWith(`${activePath}/`)
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
    'flex items-center justify-between rounded-full px-4 py-3 text-sm transition-colors',
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
export function SiteFooter() {
  const product = [
    { label: 'Features', href: ROUTES.features },
    { label: 'Pricing', href: ROUTES.pricing },
    { label: 'Use cases', href: ROUTES.useCases },
    { label: 'Comparisons', href: ROUTES.comparisons },
    { label: 'Alternatives', href: ROUTES.alternatives },
  ]
  const developers = [
    { label: 'GitHub', href: ROUTES.github },
    { label: 'MCP server', href: 'https://www.npmjs.com/package/@backenly/mcp-server' },
    { label: 'CLI', href: 'https://www.npmjs.com/package/@backenly/cli' },
    { label: 'Agent skill', href: '/skill.md' },
    { label: 'llms.txt', href: '/llms.txt' },
    { label: 'Documentation', href: ROUTES.resources },
  ]
  const company = [
    { label: 'Contact', href: ROUTES.contact },
    { label: 'Talk to the founder', href: ROUTES.founder },
    { label: 'Privacy Policy', href: ROUTES.privacy },
    { label: 'Terms of Service', href: ROUTES.terms },
    { label: 'Refund Policy', href: ROUTES.refund },
  ]

  return (
    <footer className="relative z-20 mt-auto border-t border-white/[0.08] bg-black/50 pb-8 pt-14 backdrop-blur-sm sm:pt-16">
      {/* 88rem matches the landing sections, so the footer's left edge lines
          up with the content above it. Subpages run narrower content inside
          the same footer width, which reads fine; a misaligned landing edge
          does not. */}
      <div className="mx-auto w-full max-w-[100rem] px-5 sm:px-6">
        <div className="mb-12 grid grid-cols-1 gap-10 sm:grid-cols-2 md:mb-14 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:gap-8">
          <div className="flex flex-col gap-4 sm:col-span-2 lg:col-span-1">
            <Link href={ROUTES.home} className="flex items-center gap-2.5 text-white">
              <BrandMark size={26} />
              <span className="text-base font-semibold">Backenly</span>
            </Link>
            {/* Cut from three sentences to one on 2026-09-18. The old blurb
                restated the hero ("Your coding agent builds it. Backenly keeps
                it running, every change governed, verified, and reversible")
                to a reader who had already scrolled the whole page to get
                here, and the positioning line is already in the bar below.
                What is left is the one fact a footer should carry: the one a
                stranger can go and check. */}
            <p className="max-w-xs text-sm leading-6 text-zinc-400">
              Open source under Apache-2.0.
            </p>
            <div className="mt-1 flex items-center gap-3 text-zinc-500">
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
          </div>
          <FooterCol title="Product" links={product} />
          <FooterCol title="Developers" links={developers} />
          <FooterCol title="Company" links={company} />
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-white/[0.08] pt-7 md:flex-row">
          <p className="text-xs text-zinc-600">
            &copy; {new Date().getFullYear()} Backenly. All rights reserved.
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-600">
            The autonomous backend platform
          </p>
        </div>
      </div>
    </footer>
  )
}

function FooterCol({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      {/*
        h2, not h4. These are the top-level groupings inside the footer landmark,
        and every marketing page runs h1 → h2 sections above them, so an h4 here
        produced an h2 → h4 skip on every page on the site. The level is the only
        thing that changed; the type scale is set by the classes, not the tag.
      */}
      <h2 className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {title}
      </h2>
      <ul className="space-y-2.5 text-sm text-zinc-400">
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
