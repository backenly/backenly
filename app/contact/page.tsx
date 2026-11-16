import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowUpRight, Calendar, LifeBuoy, Mail, ShieldAlert, type LucideIcon } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata } from '@/lib/seo/metadata'
import { SiteShell } from '@/components/site/SiteShell'
import { CloseBox, JsonLd, Page } from '@/components/site/kit'
import { Light } from '@/components/landing-v8/Box'
import { ContactForm } from '@/components/site/ContactForm'
import { DiscordMark, GithubMark, LinkedinMark, XMark } from '@/components/site/BrandIcons'
import { StartButton } from '@/components/site/StartButton'
import { CONTAINER, PRIMARY_CTA } from '@/components/site/tokens'

const APP_URL = 'https://backenly.com'
const SUPPORT_EMAIL = 'support@backenly.com'
// Literals, not SiteShell's ROUTES: that object comes from a client module and is undefined in a server page.
const FOUNDER_URL = 'https://calendly.com/adarsh-c-jose/30min'
const DISCORD_URL = 'https://discord.gg/6cHeYXDAu3'
const GITHUB_URL = 'https://github.com/backenly/backenly'
const X_URL = 'https://x.com/Backenly'
const LINKEDIN_URL = 'https://www.linkedin.com/company/117034579'

export const metadata: Metadata = pageMetadata({
  title: 'Contact Backenly: support, sales and founder calls',
  brandInTitle: true,
  description:
    'Contact Backenly for product support, billing questions, production issues, security reports, sales conversations, and founder calls.',
  path: '/contact',
  social: {
    title: 'Contact Backenly',
    description: 'Support, billing, production help, and founder calls for Backenly.',
  },
})

const contactSchema = {
  '@context': 'https://schema.org',
  '@type': 'ContactPage',
  name: 'Contact Backenly',
  url: `${APP_URL}/contact`,
  mainEntity: {
    '@type': 'Organization',
    name: 'Backenly',
    url: APP_URL,
    email: SUPPORT_EMAIL,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: SUPPORT_EMAIL,
        availableLanguage: ['en'],
      },
    ],
  },
}

/* ─────────────────────────────────────────────────────────────
   Contact (founders, 2026-11-15: "update the contact page professionally
   like this", with Blaxel's contact page, and "reduce the gradient a little").

   A centred head on a dimmed light; one framed box, the message form beside
   the other ways to reach a person; then the founders call in a framed
   closing, with the footer unlit. The facts are the published ones: two
   business days for support (the Terms) and 72 hours to acknowledge a
   security report (SECURITY.md, which names the address and the SECURITY
   subject). The call is a link to the booking page, not an embed (an
   embedded scheduler would load a third party's script).
───────────────────────────────────────────────────────────── */

const HEAD_FADE = 'linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.6) 45%, rgba(0,0,0,0.25) 78%, transparent 100%)'

const LINK =
  'rounded-[3px] text-[15px] font-medium text-white underline decoration-white/25 underline-offset-[4px] transition-colors duration-150 hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70'

function Way({ icon: WayIcon, label, children, note }: { icon: LucideIcon; label: string; children: ReactNode; note?: string }) {
  return (
    <li className="flex gap-[16px]">
      <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[8px] border border-white/[0.10] bg-white/[0.03]">
        <WayIcon aria-hidden className="h-[17px] w-[17px] text-violet-300" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 pt-[1px]">
        <p className="text-[13.5px] text-faint">{label}</p>
        <div className="mt-[3px]">{children}</div>
        {note && <p className="mt-[4px] text-[14px] leading-[1.5] text-zinc-400">{note}</p>}
      </div>
    </li>
  )
}

const SOCIAL = [
  { href: GITHUB_URL, label: 'GitHub', Mark: GithubMark },
  { href: DISCORD_URL, label: 'Discord', Mark: DiscordMark },
  { href: X_URL, label: 'X', Mark: XMark },
  { href: LINKEDIN_URL, label: 'LinkedIn', Mark: LinkedinMark },
]

export default function ContactPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(contactSchema)} />
      <Page>
        <section className="relative isolate overflow-hidden">
          <Light art="b" reach={560} mask={HEAD_FADE} strength={0.55} />
          <div className={`${CONTAINER} pb-[48px] pt-[64px] text-center md:pb-[64px] md:pt-[96px]`}>
            <h1 className="mx-auto max-w-[16ch] text-[44px] font-normal leading-[1.02] tracking-[-0.045em] text-white [text-wrap:balance] sm:text-[52px] md:text-[60px]">
              Contact us
            </h1>
            <p className="mx-auto mt-[20px] max-w-[46ch] text-[17px] leading-[1.6] text-zinc-300 [text-wrap:pretty] md:text-[18px]">
              Send us a message and we reply within two business days, or book a call with the founders.
            </p>
          </div>
        </section>

        <section aria-labelledby="message-title" className="relative">
          <div className={CONTAINER}>
            <div className="mx-auto grid max-w-[1120px] overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#0b0c0f] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <div className="min-w-0 p-[24px] sm:p-[40px] lg:p-[48px]">
                <h2 id="message-title" className="text-[26px] font-normal leading-[1.15] tracking-[-0.03em] text-white sm:text-[30px]">
                  Send us a message
                </h2>
                <p className="mt-[8px] text-[15px] leading-[1.6] text-zinc-400">Questions about Backenly, a plan, or a partnership.</p>
                <ContactForm />
              </div>

              <div className="min-w-0 border-t border-white/[0.08] bg-white/[0.012] p-[24px] sm:p-[40px] lg:border-l lg:border-t-0 lg:p-[48px]">
                <h2 className="text-[26px] font-normal leading-[1.15] tracking-[-0.03em] text-white sm:text-[30px]">Other ways to reach us</h2>
                <ul className="mt-[32px] grid gap-[26px]">
                  <Way icon={Mail} label="Email" note="We reply within two business days.">
                    <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
                      {SUPPORT_EMAIL}
                    </a>
                  </Way>
                  <Way icon={Calendar} label="Founders call" note="Thirty minutes, booked at a time that suits you.">
                    <a href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
                      Book a call
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </Way>
                  <Way icon={LifeBuoy} label="Already on Backenly" note="Open a case from your console, with the project attached.">
                    <Link href="/app/support/new" className={LINK}>
                      Open a support case
                    </Link>
                  </Way>
                  <Way icon={ShieldAlert} label="Security reports" note="SECURITY in the subject, never a public issue. Acknowledged within 72 hours.">
                    <a href={`mailto:${SUPPORT_EMAIL}?subject=SECURITY`} className={LINK}>
                      Report a vulnerability
                    </a>
                  </Way>
                </ul>

                <div className="mt-[36px] border-t border-white/[0.08] pt-[28px]">
                  <p className="text-[13.5px] text-faint">Find us</p>
                  <ul className="mt-[14px] flex flex-wrap gap-[10px]">
                    {SOCIAL.map(({ href, label, Mark }) => (
                      <li key={label}>
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${label} (opens in a new tab)`}
                          className="flex h-[40px] w-[40px] items-center justify-center rounded-[8px] border border-white/[0.10] bg-white/[0.03] text-zinc-300 transition-colors duration-150 hover:border-white/[0.22] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                        >
                          <Mark className="h-[18px] w-[18px]" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        <CloseBox
          narrow
          id="founders-title"
          title="Talk to the founders"
          lede="Thirty minutes for onboarding, architecture, partnerships or an Enterprise conversation."
        >
          <a href={FOUNDER_URL} target="_blank" rel="noopener noreferrer" className={PRIMARY_CTA}>
            Book a call
            <ArrowUpRight aria-hidden className="h-[16px] w-[16px]" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <StartButton variant="secondary" />
        </CloseBox>
      </Page>
    </SiteShell>
  )
}
