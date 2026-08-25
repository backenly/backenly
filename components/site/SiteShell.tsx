'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Icon } from '@iconify/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { registerSiteIcons } from '@/lib/icons/registry'
import { BrandMark } from '@/components/site/BrandMark'
import { SmoothScroll } from '@/components/site/SmoothScroll'

// Synchronously load all marketing-site icons into the Iconify cache so
// every <Icon> renders on first paint, even with no network to api.iconify.design.
registerSiteIcons()

export const ROUTES = {
  home: '/',
  signup: '/auth/signup',
  login: '/auth/login',
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
  // The flagship open-source platform repo. Must be public for this link to
  // resolve for anonymous visitors. The navbar links to it with a bare icon:
  // the star count used to be rendered beside it and was deliberately removed.
  github: 'https://github.com/backenly/backenly',
} as const

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
export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SmoothScroll />
      <div
        className="bg-black text-white antialiased relative min-h-screen overflow-x-hidden selection:bg-violet-500/30 selection:text-white font-light flex flex-col items-center"
        style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
      >
        <div className="relative w-full min-h-screen flex flex-col z-20">
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
  const reduceMotion = useReducedMotion()

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
      initial={reduceMotion ? false : { opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
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
            initial={reduceMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-1 text-[15px] font-medium text-zinc-400"
          >
            {NAV_LINKS.map((link) => (
              <DesktopNavLink key={link.label} link={link} pathname={pathname} />
            ))}
          </motion.nav>

          {/* Desktop auth buttons */}
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
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
          <span className="h-6 w-px bg-white/[0.12]" aria-hidden />
          <Link
            href={ROUTES.login}
            className="text-[15px] font-medium text-zinc-400 transition-colors hover:text-white"
          >
            Log in
          </Link>
            <Link
              href={ROUTES.signup}
              className="rounded-full bg-white px-5 py-2.5 text-[15px] font-semibold text-black transition-colors hover:bg-zinc-200"
            >
              Sign up
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
            initial={reduceMotion ? false : { opacity: 0, y: -10, scale: 0.98, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, scale: 0.98, filter: 'blur(8px)' }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 right-0 top-[76px] z-50 mx-4 rounded-lg border border-white/[0.08] bg-[#050505] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl lg:hidden"
          >
            <div className="flex flex-col gap-1 px-5 py-5">
              {NAV_LINKS.map((link, index) => (
                <motion.div
                  key={link.label}
                  initial={reduceMotion ? false : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.24, delay: index * 0.035, ease: [0.16, 1, 0.3, 1] }}
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

              <Link
                href={ROUTES.login}
                onClick={() => setMobileOpen(false)}
                className="mt-4 flex items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.03] py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                Log in
              </Link>
              <Link
                href={ROUTES.signup}
                onClick={() => setMobileOpen(false)}
                className="mt-2 flex items-center justify-center rounded-full bg-white py-3 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
              >
                Sign up
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
  const classes = [
    'relative overflow-hidden rounded-full px-4 py-2 transition-colors',
    active ? 'text-white' : 'hover:text-white',
  ].join(' ')
  const content = (
    <>
      {active && (
        <motion.span
          layoutId="site-nav-active"
          className="absolute inset-0 rounded-full bg-white/[0.11] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.6 }}
        />
      )}
      <span className="relative z-10">{link.label}</span>
    </>
  )

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
            <p className="max-w-xs text-sm leading-6 text-zinc-400">
              Your coding agent builds it. Backenly keeps it running, every change
              governed, verified, and reversible. Open source under Apache-2.0:
              self-host it, or let Backenly Cloud run it for you.
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
      <h4 className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {title}
      </h4>
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
