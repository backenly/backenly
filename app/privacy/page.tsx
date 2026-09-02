import Link from 'next/link'
import { Mail } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import { Card, PageHero, Section, SecondaryButton, Tag } from '@/components/site/kit'
import {
  EFFECTIVE_DATE,
  PRIVACY_EMAIL,
  PRIVACY_SECTIONS,
  PRIVACY_SUMMARY,
  PROVIDERS,
  type PrivacySection,
} from './data'

/**
 * Presentation only. Every claim lives in ./data.ts, which documents what this
 * rewrite corrected and why session replay is disclosed in the present tense.
 *
 * Deliberately restrained: no proof cards asserting product claims in a legal
 * document, no coloured trust badge on the summary, and `extra` renders at
 * zinc-400 rather than zinc-500 because it carries some of the most
 * consequential sentences on the page.
 */
export default function PrivacyPage() {
  return (
    <SiteShell>
      <main className="relative z-20">
        <PageHero
          eyebrow="Legal"
          title="Privacy Policy"
          subtitle="What Backenly collects, why, who else receives it, how long we keep it, and what happens when you ask us to delete it."
          proof={[{ label: 'Effective date', value: EFFECTIVE_DATE }]}
        />

        <Section width="wide-prose" className="!pt-0">
          <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-5 lg:sticky lg:top-8 lg:self-start">
              <Card>
                <Tag>The short version</Tag>
                <ul className="mt-5 space-y-3">
                  {PRIVACY_SUMMARY.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                      <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card>
                <Tag>Contents</Tag>
                <nav className="mt-5 grid gap-2">
                  {PRIVACY_SECTIONS.map((section) => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      className="rounded-md px-2 py-2 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70"
                    >
                      {section.title}
                    </a>
                  ))}
                </nav>
              </Card>
            </aside>

            <div className="space-y-5">
              {PRIVACY_SECTIONS.map((section) => (
                <PrivacyBlock key={section.id} section={section} />
              ))}
            </div>
          </div>
        </Section>

        <Section width="default" className="!pt-0">
          <Card className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Privacy questions?</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Email {PRIVACY_EMAIL} for access, deletion or any other privacy request.
              </p>
            </div>
            <SecondaryButton href={`mailto:${PRIVACY_EMAIL}`} external>
              <Mail className="h-4 w-4" />
              Contact support
            </SecondaryButton>
          </Card>
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-zinc-500">
            <Link href="/terms" className="hover:text-white">
              Terms of Service
            </Link>
            <Link href="/refund-policy" className="hover:text-white">
              Refund Policy
            </Link>
          </div>
        </Section>
      </main>
    </SiteShell>
  )
}

function PrivacyBlock({ section }: { section: PrivacySection }) {
  return (
    <section
      id={section.id}
      className="scroll-mt-24 rounded-lg border border-white/10 bg-white/[0.035] p-6"
    >
      <h2 className="text-lg font-semibold text-white">{section.title}</h2>
      <p className="mt-3 text-sm leading-7 text-zinc-400">{section.content}</p>

      {section.subsections && (
        <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-white/10 pt-5 md:grid-cols-2">
          {section.subsections.map((subsection) => (
            <div key={subsection.label}>
              <h3 className="text-sm font-semibold text-zinc-200">{subsection.label}</h3>
              <ul className="mt-3 space-y-2">
                {subsection.items.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
                    <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {section.list && (
        <ul className="mt-4 space-y-2">
          {section.list.map((item) => (
            <li key={item} className="flex gap-3 text-sm leading-6 text-zinc-400">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}

      {section.providers && <ProviderTable />}

      {/* zinc-400, not zinc-500. On this panel zinc-500 measures about 4.2:1,
          below the WCAG AA 4.5:1 floor for body text, and `extra` is where the
          international-processing and retention caveats live. */}
      {section.extra && <p className="mt-4 text-sm leading-7 text-zinc-400">{section.extra}</p>}
    </section>
  )
}

/** Wide content scrolls inside its own container so the page never does. */
function ProviderTable() {
  return (
    <div className="mt-5 overflow-x-auto rounded-md border border-white/10">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-white/10 bg-white/[0.03]">
            <th scope="col" className="px-4 py-3 font-semibold text-zinc-200">
              Provider
            </th>
            <th scope="col" className="px-4 py-3 font-semibold text-zinc-200">
              What we use it for
            </th>
            <th scope="col" className="px-4 py-3 font-semibold text-zinc-200">
              What it can receive
            </th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((provider) => (
            <tr key={provider.name} className="border-b border-white/[0.06] align-top last:border-0">
              <th scope="row" className="px-4 py-3 font-medium text-white">
                <a
                  href={provider.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-white/25 underline-offset-4 transition hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70"
                >
                  {provider.name}
                </a>
              </th>
              <td className="px-4 py-3 leading-6 text-zinc-400">{provider.purpose}</td>
              <td className="px-4 py-3 leading-6 text-zinc-400">{provider.data}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
