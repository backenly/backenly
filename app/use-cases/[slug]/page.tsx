import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { notFound } from 'next/navigation'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { USE_CASES, USE_CASE_LIST } from '../data'
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

export function generateStaticParams() {
  return USE_CASE_LIST.map((uc) => ({ slug: uc.slug }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const params = await props.params
  const uc = USE_CASES[params.slug]
  if (!uc) return { title: 'Not Found' }

  return {
    title: uc.metaTitle,
    description: uc.metaDescription,
    openGraph: {
      title: uc.metaTitle,
      description: uc.metaDescription,
      url: `${APP_URL}/use-cases/${uc.slug}`,
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title: uc.metaTitle, description: uc.metaDescription },
    alternates: { canonical: `${APP_URL}/use-cases/${uc.slug}` },
  }
}

export default async function UseCaseSlugPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params
  const uc = USE_CASES[params.slug]
  if (!uc) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: uc.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Use Cases', item: `${APP_URL}/use-cases` },
      { '@type': 'ListItem', position: 3, name: uc.label, item: `${APP_URL}/use-cases/${uc.slug}` },
    ],
  }

  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }}
      />
      <main className="relative z-20">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Use Cases', href: '/use-cases' },
            { label: uc.label },
          ]}
        />

        <PageHero
          eyebrow={uc.label}
          title={uc.headline}
          subtitle={uc.subheadline}
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Start free
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/resources">Read the docs</SecondaryButton>
            </>
          }
          proof={[
            { label: 'Who this is for', value: uc.who },
            { label: 'What you already have', value: uc.alreadyHave },
            { label: 'What you need', value: uc.need },
          ]}
        />

        {/* The situation — problem first, then the honest cost of the default path. */}
        <Section width="prose" className="!pt-0">
          <div className="flex flex-col gap-10">
            <div>
              <SectionHeading className="!text-xl mb-3">The problem</SectionHeading>
              <Lead>{uc.problem}</Lead>
            </div>
            <div>
              <SectionHeading className="!text-xl mb-3">
                What you would normally build
              </SectionHeading>
              <Lead>{uc.normallyBuild}</Lead>
            </div>
          </div>
        </Section>

        {/* The workflow — the substance of the page. A sequence, not a card grid. */}
        <Section width="prose">
          <SectionHeading className="mb-8">What Backenly does</SectionHeading>
          <ol className="relative flex flex-col gap-7 border-l border-white/10 pl-6">
            {uc.workflow.map((step) => (
              <li key={step.title} className="relative">
                <span
                  aria-hidden
                  className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full border border-white/25 bg-black"
                />
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                  {step.label}
                </p>
                <p className="mt-1 text-[15px] font-medium text-white">{step.title}</p>
                <p className="mt-1.5 text-[15px] font-light leading-7 text-neutral-400">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>

          {uc.code && (
            <div className="mt-8">
              <CodeBlock code={uc.code.code} label={uc.code.label} language={uc.code.language} />
            </div>
          )}

          <div className="mt-10">
            <SectionHeading className="!text-xl mb-3">What you end up with</SectionHeading>
            <Lead>{uc.result}</Lead>
          </div>
        </Section>

        {/* Division of labour — the question every one of these pages exists to answer. */}
        <Section width="prose">
          <SectionHeading className="mb-8">Who owns what</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                {
                  title: 'Backenly does',
                  items: uc.responsibility.platform,
                  dot: 'bg-violet-300/70',
                },
                { title: 'You own', items: uc.responsibility.you, dot: 'bg-zinc-500' },
              ] as const
            ).map((col) => (
              <div
                key={col.title}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-5"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400">
                  {col.title}
                </p>
                <ul className="mt-4 flex flex-col gap-3">
                  {col.items.map((item) => (
                    <li
                      key={item}
                      className="flex gap-2.5 text-sm font-light leading-6 text-neutral-300"
                    >
                      <span
                        aria-hidden
                        className={`mt-2 h-1 w-1 shrink-0 rounded-full ${col.dot}`}
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        {/*
          What this is built on — named, checkable capabilities rather than
          adjectives. Deliberately at `prose`, matching every other section on
          the page: at `wide-prose` this two-column table ran ~400px wider than
          the prose above and below it, and the jump read as a broken column
          rather than as emphasis.
        */}
        <Section aria-label="Capabilities used" width="prose">
          <SectionHeading className="mb-8">What this is built on</SectionHeading>
          <div className="-mx-1 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.03]">
                  <th
                    scope="col"
                    className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400"
                  >
                    Capability
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400"
                  >
                    What it does here
                  </th>
                </tr>
              </thead>
              <tbody>
                {uc.capabilities.map((cap) => (
                  <tr key={cap.name} className="border-b border-white/[0.06] last:border-0">
                    <td className="px-4 py-3 align-top font-mono text-[13px] leading-6 text-zinc-200">
                      {cap.name}
                    </td>
                    <td className="px-4 py-3 align-top text-sm font-light leading-6 text-neutral-400">
                      {cap.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/*
          Limitations get a real section, not a footnote. A use-case page that
          cannot say where it stops is a brochure.
        */}
        <Section width="prose">
          <SectionHeading className="mb-6">Known limitations</SectionHeading>
          <ul className="flex flex-col gap-3">
            {uc.limitations.map((item) => (
              <li
                key={item}
                className="flex gap-3 text-[15px] font-light leading-7 text-neutral-300"
              >
                <span aria-hidden className="mt-3 h-1 w-1 shrink-0 rounded-full bg-zinc-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Common questions</SectionHeading>
          <FaqList items={uc.faq} />
        </Section>

        <Section aria-label="Other use cases" className="!py-12">
          <ChipRow label="Other workflows:">
            {USE_CASE_LIST.filter((u) => u.slug !== uc.slug).map((u) => (
              <ChipLink key={u.slug} href={`/use-cases/${u.slug}`}>
                {u.label}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Try it on one free project"
          body="No credit card. Connect your agent over MCP and judge it by the verification evidence."
        >
          <PrimaryButton href="/auth/signup">Start free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
