import { SiteShell } from '@/components/site/SiteShell'
import { DataTable, Page } from '@/components/site/kit'
import {
  LEGAL_TEXT,
  LegalContact,
  LegalDocument,
  LegalList,
  LegalPanel,
  LegalSection,
  MetaDivider,
} from '@/components/site/legal'
import { HEADING } from '@/components/site/tokens'
import {
  EFFECTIVE_DATE,
  PRIVACY_EMAIL,
  PRIVACY_SECTIONS,
  PRIVACY_SUMMARY,
  PROVIDERS,
  type PrivacySection,
} from './data'

/**
 * Presentation only. Every claim lives in ./data.ts, which documents what the
 * policy rewrite corrected and why session replay is disclosed in the present
 * tense.
 *
 * Deliberately restrained: no proof cards asserting product claims in a legal
 * document and no coloured trust badge on the summary. Set as a docs page
 * (components/site/legal.tsx): the documents beside it, the policy at a
 * reading measure, and its contents following the scroll.
 */
export default function PrivacyPage() {
  return (
    <SiteShell>
      <Page>
        <LegalDocument
          current="privacy"
          summary="What Backenly collects, why, who else receives it, how long we keep it, and what happens when you ask us to delete it."
          meta={
            <>
              <span>
                Effective <span className="text-zinc-200">{EFFECTIVE_DATE}</span>
              </span>
              <MetaDivider />
              <span>
                Contact <span className="text-zinc-200">{PRIVACY_EMAIL}</span>
              </span>
            </>
          }
          toc={PRIVACY_SECTIONS.map((s) => ({ id: s.id, label: s.title }))}
        >
          <LegalPanel title="The short version" items={PRIVACY_SUMMARY} />

          {PRIVACY_SECTIONS.map((section) => (
            <PrivacyBlock key={section.id} section={section} />
          ))}

          <LegalContact
            title="Privacy questions?"
            body={`Email ${PRIVACY_EMAIL} for access, deletion or any other privacy request.`}
            email={PRIVACY_EMAIL}
          />
        </LegalDocument>
      </Page>
    </SiteShell>
  )
}

function PrivacyBlock({ section }: { section: PrivacySection }) {
  return (
    <LegalSection id={section.id} title={section.title}>
      <p className={LEGAL_TEXT}>{section.content}</p>

      {section.subsections && (
        <div className="grid gap-x-10 gap-y-7 border-t border-white/[0.08] pt-6 md:grid-cols-2">
          {section.subsections.map((subsection) => (
            <div key={subsection.label} className="min-w-0">
              <h3 className={`text-[15px] text-white ${HEADING}`}>{subsection.label}</h3>
              <div className="mt-[12px]">
                <LegalList items={subsection.items} size="small" />
              </div>
            </div>
          ))}
        </div>
      )}

      {section.list && <LegalList items={section.list} />}

      {section.providers && (
        <DataTable
          caption="Providers that can receive personal or customer data"
          columns={['Provider', 'What we use it for', 'What it can receive']}
          rows={PROVIDERS.map((provider) => [
            <a
              key={provider.name}
              href={provider.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white underline decoration-white/25 underline-offset-4 transition-colors duration-200 hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
            >
              {provider.name}
            </a>,
            provider.purpose,
            provider.data,
          ])}
        />
      )}

      {/* `extra` carries some of the most consequential sentences on the page
          (international processing, retention), so it is set at full body
          contrast rather than as a muted footnote. */}
      {section.extra && <p className={LEGAL_TEXT}>{section.extra}</p>}
    </LegalSection>
  )
}
