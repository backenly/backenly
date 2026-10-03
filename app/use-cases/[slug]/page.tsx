import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import {
  ButtonLink,
  DataTable,
  GlyphList,
  HorizonClose,
  JsonLd,
  NextLinks,
  Page,
  PageHero,
  Section,
  SectionHead,
  Steps,
  withCode,
} from '@/components/site/kit'
import { Faq } from '@/components/site/Faq'
import { Reveal } from '@/components/site/Reveal'
import { StartButton } from '@/components/site/StartButton'
import { HEADING, PANEL, TITLE } from '@/components/site/tokens'
import { USE_CASES, USE_CASE_LIST } from '../data'

const APP_URL = 'https://backenly.com'

export function generateStaticParams() {
  return USE_CASE_LIST.map((uc) => ({ slug: uc.slug }))
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
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

/* ─────────────────────────────────────────────────────────────
   A use case, read top to bottom as an argument:

     who it is for          three facts under the hero
     the situation          the problem beside what you would normally build
     the mechanism          the sequence Backenly runs, with the session or
                            code it produces pinned beside it
     the outcome            one statement
     the division of labour what Backenly does, what you own
     the evidence           the named capabilities it is built on
     the boundary           known limitations, given a section of their own
───────────────────────────────────────────────────────────── */

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

  const profile = [
    { label: 'Who this is for', value: uc.who },
    { label: 'What you already have', value: uc.alreadyHave },
    { label: 'What you need', value: uc.need },
  ]

  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(faqSchema)} />
      <JsonLd json={safeJsonLd(breadcrumbSchema)} />
      <Page>
        <PageHero
          trail={[
            { label: 'Home', href: '/' },
            { label: 'Use cases', href: '/use-cases' },
            { label: uc.label },
          ]}
          title={uc.headline}
          lede={uc.subheadline}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/resources" variant="secondary">
                Read the docs
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-label="Who this is for">
          <Reveal>
            <dl className="grid gap-x-8 gap-y-8 md:grid-cols-3">
              {profile.map((item) => (
                <div key={item.label} className="min-w-0 border-t border-white/[0.10] pt-5">
                  <dt className="text-[13px] text-zinc-500">{item.label}</dt>
                  <dd className="mt-2 text-[17px] font-medium leading-[1.45] tracking-[-0.014em] text-white">
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </Section>

        {/* The situation: the problem, beside the honest cost of the default path. */}
        <Section aria-label="The situation">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <h2 className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>The problem</h2>
              <p className="mt-5 max-w-[60ch] text-[17px] leading-[1.75] tracking-[-0.01em] text-zinc-300 [text-wrap:pretty]">
                {withCode(uc.problem)}
              </p>
            </Reveal>
            <Reveal delay={0.06}>
              <h2 className={`text-[26px] text-white md:text-[34px] ${TITLE}`}>What you would normally build</h2>
              <p className="mt-5 max-w-[60ch] text-[17px] leading-[1.75] tracking-[-0.01em] text-zinc-400 [text-wrap:pretty]">
                {withCode(uc.normallyBuild)}
              </p>
            </Reveal>
          </div>
        </Section>

        {/* The mechanism: the substance of the page. A sequence, with the
            session it produces pinned beside it while the steps scroll. */}
        <Section aria-labelledby="what-backenly-does">
          <Reveal>
            <SectionHead id="what-backenly-does" title="What Backenly does" />
          </Reveal>
          <div
            className={`mt-12 grid gap-12 ${uc.code ? 'lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:gap-16' : ''}`}
          >
            <Reveal>
              <Steps steps={uc.workflow} />
            </Reveal>
            {uc.code && (
              <Reveal delay={0.08} className="lg:sticky lg:top-28 lg:self-start">
                <CodeBlock code={uc.code.code} label={uc.code.label} language={uc.code.language} />
              </Reveal>
            )}
          </div>
        </Section>

        {/* The outcome, as one statement under a lit edge. */}
        <Section aria-labelledby="end-up-with">
          <Reveal className="relative border-t border-white/[0.10] pt-12">
            <span
              aria-hidden
              className="pointer-events-none absolute -top-px left-0 h-px w-[40%] bg-[linear-gradient(to_right,rgba(196,181,253,0.7),transparent)]"
            />
            <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
              <h2 id="end-up-with" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
                What you end up with
              </h2>
              <p className="max-w-[58ch] text-[20px] leading-[1.6] tracking-[-0.018em] text-zinc-200 [text-wrap:pretty] md:text-[24px] md:leading-[1.5]">
                {withCode(uc.result)}
              </p>
            </div>
          </Reveal>
        </Section>

        {/* Division of labour: the question every one of these pages exists to answer. */}
        <Section aria-labelledby="who-owns-what">
          <Reveal>
            <SectionHead id="who-owns-what" title="Who owns what" />
          </Reveal>
          <Reveal delay={0.06} className="mt-12 grid gap-3 md:grid-cols-2">
            <div className={`p-6 md:p-8 ${PANEL}`}>
              <h3 className={`text-[19px] text-white ${HEADING}`}>Backenly does</h3>
              <GlyphList className="mt-6" glyph="check" items={uc.responsibility.platform.map(withCode)} />
            </div>
            <div className={`p-6 md:p-8 ${PANEL}`}>
              <h3 className={`text-[19px] text-white ${HEADING}`}>You own</h3>
              <GlyphList className="mt-6" glyph="dash" items={uc.responsibility.you.map(withCode)} />
            </div>
          </Reveal>
        </Section>

        {/* Named, checkable capabilities rather than adjectives. */}
        <Section aria-labelledby="built-on">
          <Reveal>
            <SectionHead
              id="built-on"
              title="What this is built on"
              lede="The tools, routes and modules involved, by name, so you can go and check each one."
            />
          </Reveal>
          <Reveal delay={0.06} className="mt-12">
            <DataTable
              caption={`Capabilities used in ${uc.label}`}
              columns={['Capability', 'What it does here']}
              codeFirstColumn
              rows={uc.capabilities.map((cap) => [cap.name, withCode(cap.detail)])}
            />
          </Reveal>
        </Section>

        {/* Limitations get a real section, not a footnote. */}
        <Section aria-labelledby="limitations">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <Reveal>
              <SectionHead
                id="limitations"
                title="Known limitations"
                lede="Where this workflow stops. If one of these is load-bearing for you, it should decide it."
              />
            </Reveal>
            <Reveal delay={0.06}>
              <GlyphList glyph="dash" items={uc.limitations.map(withCode)} className="lg:pt-3" />
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="use-case-faq">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <Reveal className="lg:sticky lg:top-28 lg:self-start">
              <SectionHead id="use-case-faq" title="Common questions" />
            </Reveal>
            <Reveal delay={0.06}>
              <Faq items={uc.faq} />
            </Reveal>
          </div>
        </Section>

        <Section aria-labelledby="other-workflows">
          <Reveal>
            <h2 id="other-workflows" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
              Other workflows
            </h2>
            <NextLinks
              className="mt-8"
              items={USE_CASE_LIST.filter((u) => u.slug !== uc.slug).map((u) => ({
                href: `/use-cases/${u.slug}`,
                meta: u.label,
                title: u.headline,
              }))}
            />
          </Reveal>
        </Section>

        <HorizonClose
          title="Try it on one free project"
          lede="No credit card. Connect your agent over MCP and judge it by the verification evidence."
        >
          <StartButton />
          <ButtonLink href="/resources/connect-your-coding-agent" variant="secondary">
            Connect your agent
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
