import type { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { pageMetadata, SITE_URL } from '@/lib/seo/metadata'
import { graph, ORGANIZATION_ID } from '@/lib/seo/schema'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { SpotlightPanel } from '@/components/site/SpotlightPanel'
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
import { HEADING, MEASURE } from '@/components/site/tokens'
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
───────────────────────────────────────────────────────────── */

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

export default function McpPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(structuredData)} />
      <Page>
        <PageHero
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
            size="sm"
            title="Connect your agent"
            lede="A scoped key comes from your project’s Connect page, under Agents. It is bound to one project, and you can revoke it there. The Connect page prints each block below with your project id and key filled in."
          />
          <div className="mt-[40px] grid gap-[12px] lg:grid-cols-2">
            {INSTALLS.map((install) => (
              <SpotlightPanel key={install.id} className="flex min-w-0 flex-col gap-[14px] p-[24px] md:p-[28px]">
                <div>
                  <p className="text-[13px] font-medium text-violet-300">{install.client}</p>
                  <h3 className={`mt-1 text-[17px] text-white ${HEADING}`}>{install.title}</h3>
                  <p className="mt-[8px] max-w-[60ch] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">{install.note}</p>
                </div>
                {/* One-line commands wrap so the whole command is visible; JSON keeps its lines. */}
                <CodeBlock code={install.code} language={install.language} wrap={install.language === 'bash'} />
              </SpotlightPanel>
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
            size="sm"
            title={`${ADVERTISED_TOOL_COUNT} tools, grouped by job`}
            lede={`A read-write connection sees ${ADVERTISED_TOOL_COUNT}. A read-only key or sign-in sees ${READ_ONLY_TOOL_COUNT}: the read tools, and each section tool narrowed to its read actions.`}
          />
          <div className="mt-[40px]">
            <DataTable
              caption="The tools the Backenly MCP server advertises, by what they are for"
              columns={['What it is for', 'Tools', 'What they do']}
              minWidth="min-w-[760px]"
              rows={TOOL_GROUPS.map((group) => [
                group.title,
                <span key="t" className="flex flex-wrap gap-x-2 gap-y-1">
                  {group.tools.map((tool) => (
                    <span key={tool}>{mono(tool)}</span>
                  ))}
                </span>,
                group.body,
              ])}
            />
          </div>
        </Section>

        <Section aria-labelledby="approvals">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div>
              <SectionHead
                id="approvals"
                size="sm"
                title="What waits for you"
                lede="Destructive or irreversible actions do not run from the call. Dropping or emptying a table, dropping a column and discarding a branch go through backend_chat, which parks them the same way. apply_migration refuses DROP statements outright and says so."
              />
              <div className="mt-[32px] flex flex-col gap-[10px]">
                {GATED_ACTIONS.map((section) => (
                  <p key={section.tool} className="text-[15px] leading-[1.7] text-zinc-400">
                    {mono(section.tool)}
                    <span className="text-zinc-600"> · </span>
                    {section.actions.map((action, i) => (
                      <span key={action}>
                        {i > 0 && ', '}
                        {mono(action)}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            </div>
            <Steps steps={APPROVAL_STEPS} />
          </div>
        </Section>

        <Section aria-labelledby="boundaries">
          <SectionHead id="boundaries" size="sm" title="Where it stops" />
          <div className="mt-[40px] grid gap-[12px] md:grid-cols-3">
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
              <SpotlightPanel key={item.title} className="p-[24px] md:p-[28px]">
                <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
                <p className="mt-[10px] text-[15px] leading-[1.7] text-zinc-400 [text-wrap:pretty]">{withCode(item.body)}</p>
              </SpotlightPanel>
            ))}
          </div>
        </Section>

        <Section aria-labelledby="mcp-faq">
          <div className="grid gap-[40px] lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-[64px]">
            <div className="lg:sticky lg:top-[112px] lg:self-start">
              <SectionHead id="mcp-faq" size="sm" title="Questions" />
            </div>
            <Faq items={FAQ} />
          </div>
        </Section>

        <Section aria-labelledby="mcp-next">
          <SectionHead id="mcp-next" size="sm" title="Go further" />
          <NextLinks
            className="mt-[32px]"
            items={[
              { href: '/docs/connect', title: 'Connect: the step-by-step guide' },
              { href: '/docs/database', title: 'How a schema change is applied and checked' },
              { href: '/docs/autonomy', title: 'Approvals and the maintenance loop' },
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
