import type { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import { SiteShell } from '@/components/site/SiteShell'
import { CodeBlock } from '@/components/site/CodeBlock'
import { BentoCell, CellBody, CellTitle } from '@/components/landing-v7/shared'
import { ButtonLink, JsonLd, Page, PageHero, Section, SectionHead, withCode } from '@/components/site/kit'
import { StartButton } from '@/components/site/StartButton'
import { CLAUDE_CODE as page } from '../data'
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
   /agents/claude-code — Backenly from Claude Code.

   For the developer who searched for a database for Claude Code. Only what is
   particular to Claude Code: the three `claude mcp add` forms, what happens
   in the conversation that ran one (the CLI) and in the next (/exit, claude
   --continue, /mcp), what Claude Code is told on connect and by the skill,
   and what the key reaches. The tool list and the approval flow are /mcp's.

   Content: app/agents/data.ts, held to the source by
   tests/unit/agent-pages-conformance.spec.ts.
───────────────────────────────────────────────────────────── */

export const metadata: Metadata = agentMetadata(page)

export default function ClaudeCodePage() {
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

        <Section flush aria-labelledby="install">
          <SectionHead
            id="install"
            title={
              <>
                Add it in one command. <span className="text-zinc-500">Then start a new session.</span>
              </>
            }
          />
          <ul className={`${BODY_GAP} grid gap-3 lg:grid-cols-3`}>
            {page.installs.map((install) => (
              <li key={install.id} className="min-w-0">
                <BentoCell className="h-full">
                  <CellTitle>{install.title}</CellTitle>
                  {/* A five-line floor (the sign-in runs five), so the three commands start on one line. */}
                  <CellBody className="[text-wrap:pretty] lg:min-h-[128px]">{withCode(install.body)}</CellBody>
                  <CellCode code={install.code} />
                </BentoCell>
              </li>
            ))}
          </ul>
          <Note className="mt-[24px]">{page.keyFree}</Note>
        </Section>

        <Section aria-labelledby="conversation">
          <SectionHead
            id="conversation"
            title={
              <>
                Tools arrive next session. <span className="text-zinc-500">The CLI works until then.</span>
              </>
            }
          />
          <div className={`${BODY_GAP} grid gap-3 lg:grid-cols-2`}>
            <BentoCell className="h-full">
              <CellTitle>{page.session.now.title}</CellTitle>
              {/* A four-line floor, so the commands and the prompt start on one line. */}
              <CellBody className="[text-wrap:pretty] lg:min-h-[102px]">{withCode(page.session.now.body)}</CellBody>
              <CellCode code={page.session.now.code} />
              <p className="mt-[16px] text-[14px] leading-[1.6] text-zinc-500 [text-wrap:pretty]">
                {withCode(page.session.now.note)}
              </p>
            </BentoCell>
            <BentoCell className="h-full">
              <CellTitle>{page.session.next.title}</CellTitle>
              <CellBody className="[text-wrap:pretty] lg:min-h-[102px]">{withCode(page.session.next.body)}</CellBody>
              <div className="mt-[24px] min-w-0">
                <CodeBlock code={page.session.next.prompt} label="Ask Claude Code" language="text" wrap />
              </div>
            </BentoCell>
          </div>
        </Section>

        <Section aria-labelledby="context">
          <SectionHead
            id="context"
            title={
              <>
                What Claude Code is told. <span className="text-zinc-500">By the server and the repo.</span>
              </>
            }
          />
          {/* Two cells of words, then the skill wide, its command beside it. */}
          <ul className={`${BODY_GAP} grid gap-3 md:grid-cols-2`}>
            {page.context.map((cell) =>
              cell.code ? (
                <li key={cell.title} className="min-w-0 md:col-span-2">
                  <WideCodeCell title={cell.title} body={cell.body} code={cell.code} />
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

        <Section aria-labelledby="access">
          <SectionHead
            id="access"
            title={
              <>
                What the key reaches. <span className="text-zinc-500">Only what you allow.</span>
              </>
            }
          />
          <ul className={`${BODY_GAP} grid gap-3 md:grid-cols-2`}>
            {page.access.map((cell) => (
              <li key={cell.title} className="min-w-0">
                <BentoCell className="h-full">
                  <CellTitle>{cell.title}</CellTitle>
                  <CellBody className="[text-wrap:pretty]">{withCode(cell.body)}</CellBody>
                </BentoCell>
              </li>
            ))}
          </ul>
        </Section>

        <AgentFaq id="claude-code-faq" title="Questions about Claude Code" items={page.faq} />

        <AgentNext items={page.next} />

        <AgentClose page={page} />
      </Page>
    </SiteShell>
  )
}
