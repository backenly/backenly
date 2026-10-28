import type { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import { ButtonLink, JsonLd, Page, PageHero, Section, SectionHead, withCode } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { CURSOR as page } from '../data'
import {
  AgentClose,
  AgentFaq,
  AgentNext,
  BODY_GAP,
  CellCode,
  Note,
  WideCodeCell,
  agentMetadata,
  agentStructuredData,
  agentTrail,
} from '../shared'

/* ─────────────────────────────────────────────────────────────
   /agents/cursor — Backenly from Cursor.

   Cursor takes a JSON block rather than a command, so this page is about the
   block and where it lives: the remote and local forms, why the user config
   and not the project's (a key beside the app is a key an agent can ship),
   the key-free block `init` prints, the .cursor/rules file, and the CLI for a
   session that has not loaded the tools. The tool list and the approval flow
   are /mcp's.

   Content: app/agents/data.ts, held to the source by
   tests/unit/agent-pages-conformance.spec.ts.
───────────────────────────────────────────────────────────── */

export const metadata: Metadata = agentMetadata(page)

export default function CursorPage() {
  return (
    <SiteShell>
      <JsonLd json={safeJsonLd(agentStructuredData(page))} />
      <Page>
        <PageHero
          readableTrail
          trail={agentTrail(page)}
          title={page.title}
          lede={page.lede}
          actions={
            <>
              <StartButton />
              <ButtonLink href="/docs/connect" variant="secondary">
                Setup guide
              </ButtonLink>
            </>
          }
        />

        <Section flush aria-labelledby="config">
          <SectionHead
            id="config"
            title={
              <>
                One block in mcp.json. <span className="text-zinc-500">In your user config.</span>
              </>
            }
          />
          <ul className={`${BODY_GAP} grid gap-3 lg:grid-cols-2`}>
            {page.configs.map((config) => (
              <li key={config.id} className="min-w-0">
                <BentoCell className="h-full">
                  <CellTitle>{config.title}</CellTitle>
                  {/* A three-line floor (the local note runs three), so both blocks start on one line. */}
                  <CellBody className="[text-wrap:pretty] lg:min-h-[77px]">{withCode(config.body)}</CellBody>
                  <CellCode code={config.code} language="json" label="~/.cursor/mcp.json" />
                </BentoCell>
              </li>
            ))}
          </ul>
          <Note className="mt-[24px]">{page.configNote}</Note>
        </Section>

        <Section aria-labelledby="placement">
          <SectionHead
            id="placement"
            title={
              <>
                Where the key lives. <span className="text-zinc-500">Out of the repository.</span>
              </>
            }
          />
          {/* The two files side by side, then the way to keep the key out of both, wide, its block beside it. */}
          <ul className={`${BODY_GAP} grid gap-3 md:grid-cols-2`}>
            {page.placement.map((cell) =>
              cell.code ? (
                <li key={cell.title} className="min-w-0 md:col-span-2">
                  <WideCodeCell title={cell.title} body={cell.body} code={cell.code} language="json" label="~/.cursor/mcp.json" />
                </li>
              ) : (
                <li key={cell.title} className="min-w-0">
                  <BentoCell className="h-full">
                    <CellTitle>{cell.title}</CellTitle>
                    <CellBody className="[text-wrap:pretty]">{withCode(cell.body)}</CellBody>
                  </BentoCell>
                </li>
              ),
            )}
          </ul>
        </Section>

        <Section aria-labelledby="agent-context">
          <SectionHead
            id="agent-context"
            title={
              <>
                Teach the agent Backenly. <span className="text-zinc-500">Even before the tools load.</span>
              </>
            }
          />
          <div className={`${BODY_GAP} grid gap-3 lg:grid-cols-2`}>
            <BentoCell className="h-full">
              <CellTitle>{page.rules.title}</CellTitle>
              {/* A four-line floor (the rule's note runs four), so both blocks start on one line. */}
              <CellBody className="[text-wrap:pretty] lg:min-h-[102px]">{withCode(page.rules.body)}</CellBody>
              <CellCode code={page.rules.code} />
            </BentoCell>
            <BentoCell className="h-full">
              <CellTitle>{page.fallback.title}</CellTitle>
              <CellBody className="[text-wrap:pretty] lg:min-h-[102px]">{withCode(page.fallback.body)}</CellBody>
              <CellCode code={page.fallback.code} />
              <p className="mt-[16px] text-[14px] leading-[1.6] text-zinc-500 [text-wrap:pretty]">
                {withCode(page.fallback.note)}
              </p>
            </BentoCell>
          </div>
        </Section>

        <AgentFaq id="cursor-faq" title="Questions about Cursor" items={page.faq} />

        <AgentNext items={page.next} />

        <AgentClose page={page} />
      </Page>
    </SiteShell>
  )
}
