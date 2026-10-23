import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import {
  ButtonLink,
  DataTable,
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
import { StartButton } from '@/components/site/StartButton'
import { HEADING, MEASURE, TEXT_LINK, TITLE } from '@/components/site/tokens'
import {
  ADVERTISED_TOOL_COUNT,
  APPROVAL_STEPS,
  FAQ,
  GATED_ACTIONS,
  INSTALLS,
  MCP_ENDPOINT,
  READ_ONLY_TOOL_COUNT,
  TOOL_GROUPS,
} from './data'

/* ─────────────────────────────────────────────────────────────
   /mcp — the Backenly MCP server.

   The page for a developer who searched for an MCP server for their backend
   and needs to decide quickly: what it connects to (a Backenly project, not
   any Postgres), how their client installs it, what the agent can do, and
   what it cannot do without them. It replaces a redirect to /docs/connect,
   which stays the step-by-step guide; this page links there.

   The content is app/mcp/data.ts, held to the catalog by
   tests/unit/mcp-page-conformance.spec.ts.

   Set like the subpages rebuilt to match the landing (app/alternatives): the
   landing's section titles with their grey continuation, its bento cells, the
   landing FAQ's header, and next links that say what each page is. Violet is
   not used here: nothing on the page is an answer set against another
   platform's.
───────────────────────────────────────────────────────────── */

/** The gap between a section title and its first cell, as on /alternatives. */
const BODY_GAP = 'mt-[40px] md:mt-[56px]'

/** The landing FAQ's founder link. Literal for the reason app/alternatives gives: keep it equal to ROUTES.founder. */
const FOUNDERS_HREF = 'https://calendly.com/adarsh-c-jose/30min'

export const metadata: Metadata = pageMetadata({
  title: 'MCP server for a production Postgres backend',
  description:
    'Connect Claude Code, Cursor or Codex to a Backenly project over MCP: schema, data, auth, storage and functions, with destructive actions held for your approval.',
  path: '/mcp',
  social: {
    title: 'The Backenly MCP server',
    description: 'Your coding agent builds and runs a real Postgres backend over MCP. Anything destructive waits for you.',
  },
})

const URL = `${SITE_URL}/mcp`

const structuredData = graph(
  {
    '@type': 'SoftwareApplication',
    '@id': `${URL}#server`,
    name: 'Backenly MCP server',
    url: URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    softwareRequirements: 'Node.js 20 or later for the stdio package; nothing for the remote endpoint',
    downloadUrl: 'https://www.npmjs.com/package/@backenly/mcp-server',
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    publisher: { '@id': ORGANIZATION_ID },
  },
  {
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
  },
  {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'MCP server', item: URL },
    ],
  },
)

const mono = (name: string) => <code className="font-mono text-[13px] text-zinc-200">{name}</code>

/** Names as a comma list: a sentence of identifiers, not a cloud of chips. */
function monoList(names: string[]) {
  return names.map((name, i) => (
    <span key={name}>
      {i > 0 && <span className="text-zinc-500">, </span>}
      {mono(name)}
    </span>
  ))
}

export default function McpPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <PageHero
          readableTrail
          trail={[{ label: 'Home', href: '/' }, { label: 'MCP server' }]}
          title="The Backenly MCP server"
          lede="Your coding agent builds and runs a backend through it: PostgreSQL, REST APIs, auth, storage, realtime and functions in a Backenly project. Reads are open, schema changes are checked and verified, and anything destructive waits for you."
          actions={
            <>
              <StartButton />
              <ButtonLink href="/docs/connect" variant="secondary">
                Setup guide
              </ButtonLink>
            </>
          }
          aside={<CodeBlock code={INSTALLS[0].code} label="Claude Code" language="bash" wrap />}
        />

        <Section flush aria-labelledby="install">
          <SectionHead
            id="install"
            title={
              <>
                Connect your agent. <span className="text-zinc-500">One key, one project.</span>
              </>
            }
            lede="The key comes from your project’s Connect page, under Agents, and you can revoke it there. That page prints each block below with your project id and key filled in."
          />
          <div className={`${BODY_GAP} grid gap-3 lg:grid-cols-2`}>
            {INSTALLS.map((install) => (
              <BentoCell key={install.id} className="h-full">
                <p className="text-[13px] font-medium text-zinc-500">{install.client}</p>
                <div className="mt-2">
                  <CellTitle>{install.title}</CellTitle>
                </div>
                <CellBody className="max-w-[60ch] [text-wrap:pretty]">{install.note}</CellBody>
                {/* One-line commands wrap so the whole command is visible; JSON keeps its lines. */}
                <div className="mt-6">
                  <CodeBlock code={install.code} language={install.language} wrap={install.language === 'bash'} />
                </div>
              </BentoCell>
            ))}
          </div>
          <p className={`mt-[24px] ${MEASURE} text-[15px] leading-[1.7] text-zinc-400`}>
            Registered a server mid-conversation? Its tools appear in the next one. Until then, every tool is callable
            from the shell with the same key and the same rules: {mono('npx -y @backenly/cli@latest call read_backend_state')}.
          </p>
        </Section>

        <Section aria-labelledby="tools">
          <SectionHead
            id="tools"
            title={
              <>
                {ADVERTISED_TOOL_COUNT} tools, grouped by job.{' '}
                <span className="text-zinc-500">{READ_ONLY_TOOL_COUNT} on a read-only key.</span>
              </>
            }
            lede="A read-only key or sign-in keeps the read tools and narrows each section tool to its read actions."
          />
          <div className={BODY_GAP}>
            <DataTable
              caption="The tools the Backenly MCP server advertises, by what they are for"
              columns={['What it is for', 'Tools', 'What they do']}
              minWidth="min-w-[760px]"
              rows={TOOL_GROUPS.map((group) => [
                group.title,
                <span key="t">{monoList(group.tools)}</span>,
                group.body,
              ])}
            />
          </div>
        </Section>

        <Section aria-labelledby="approvals">
          <SectionHead
            id="approvals"
            title={
              <>
                What waits for you. <span className="text-zinc-500">Destructive calls are parked, not run.</span>
              </>
            }
            lede={withCode(
              'Dropping or emptying a table, dropping a column and discarding a branch go through `backend_chat`, which parks them the same way. `apply_migration` refuses `DROP` statements outright and says so.',
            )}
          />
          <div className={`${BODY_GAP} grid gap-3 lg:grid-cols-2`}>
            <BentoCell className="h-full">
              <CellTitle>Section actions that need a person</CellTitle>
              <ul className="mt-[18px] flex flex-col">
                {GATED_ACTIONS.map((section) => (
                  <li
                    key={section.tool}
                    className="grid grid-cols-[104px_minmax(0,1fr)] gap-[12px] border-t border-white/[0.07] py-[12px] first:border-t-0 first:pt-0 last:pb-0"
                  >
                    <span className={`text-[15px] text-zinc-100 ${HEADING}`}>{section.tool}</span>
                    <span className="text-[14px] leading-[1.7]">{monoList(section.actions)}</span>
                  </li>
                ))}
              </ul>
            </BentoCell>
            <BentoCell className="h-full">
              <CellTitle>How an approval runs</CellTitle>
              <Steps className="mt-[24px]" steps={APPROVAL_STEPS} />
            </BentoCell>
          </div>
        </Section>

        <Section aria-labelledby="boundaries">
          <SectionHead
            id="boundaries"
            title={
              <>
                Where it stops. <span className="text-zinc-500">Limits an agent cannot change.</span>
              </>
            }
          />
          <div className={`${BODY_GAP} grid gap-3 md:grid-cols-3`}>
            {[
              {
                title: 'One project per connection',
                body: 'Every key and sign-in is bound to one project, so a leaked credential reaches that project and nothing else. `connect { action: "whoami" }` says which one. Projects are created in the dashboard.',
              },
              {
                title: 'A Backenly project, not any database',
                body: 'It operates the PostgreSQL schema Backenly runs for the project. It is not a client for a database Backenly does not manage, though you can read that schema directly with a connection string.',
              },
              {
                title: 'Agents cannot widen their own access',
                body: 'MCP keys are issued in the dashboard, and read-only is chosen there. The runtime API your app calls refuses an MCP key (`MCP_KEY_IN_APP`), and a service-role key is never issued to an agent.',
              },
            ].map((item) => (
              <BentoCell key={item.title} className="h-full">
                <CellTitle>{item.title}</CellTitle>
                <CellBody className="[text-wrap:pretty]">{withCode(item.body)}</CellBody>
              </BentoCell>
            ))}
          </div>
        </Section>

        <Section aria-labelledby="mcp-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="mcp-faq" title="Questions about the MCP server" />
              {/* The landing FAQ's own close to the header. */}
              <p className="mt-5 max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
                Anything else, ask the people who built it.
              </p>
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
                <Link href="/docs/connect" className={TEXT_LINK}>
                  Read the setup guide
                  <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
                <a href={FOUNDERS_HREF} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
                  Book 30 minutes
                  <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </a>
              </div>
            </div>
            <Faq items={FAQ} />
          </div>
        </Section>

        <Section aria-labelledby="mcp-next">
          <h2 id="mcp-next" className={`text-[22px] text-white md:text-[26px] ${TITLE}`}>
            Read next
          </h2>
          <NextLinks
            className="mt-[28px]"
            items={[
              { href: '/docs/connect', meta: 'Docs', title: 'Connect', body: 'The setup for each client, step by step.' },
              {
                href: '/agents/claude-code',
                meta: 'Claude Code',
                title: 'Backenly in Claude Code',
                body: 'Three ways to connect, and what to do before the tools load.',
              },
              {
                href: '/agents/cursor',
                meta: 'Cursor',
                title: 'Backenly in Cursor',
                body: 'The mcp.json block, and why it belongs in your user config.',
              },
              {
                href: '/guides/safe-ai-database-changes',
                meta: 'Guide',
                title: 'Safe database changes with AI agents',
                body: 'How a change is checked, verified and restored, with a production run.',
              },
            ]}
          />
        </Section>

        <HorizonClose title="Give your agent a backend" lede={`One free project, no credit card. The endpoint is ${MCP_ENDPOINT}.`}>
          <StartButton />
          <ButtonLink href="/docs/connect" variant="secondary">
            Setup guide
          </ButtonLink>
        </HorizonClose>
      </Page>
    </SiteShell>
  )
}
