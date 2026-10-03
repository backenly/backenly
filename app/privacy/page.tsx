import { SiteShell } from '@/components/site/SiteShell'
import { DataTable, Page, PageHero } from '@/components/site/kit'
import { LEGAL_TEXT, LegalBody, LegalFooter, LegalList, LegalSection } from '@/components/site/legal'
import { HEADING, PANEL } from '@/components/site/tokens'
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
 * document and no coloured trust badge on the summary. The document is set as a
 * document, in one readable column with a contents rail beside it.
 */
export default function PrivacyPage() {
  return (
    <SiteShell>
      <Page>
        <PageHero
          size="compact"
          trail={[{ label: 'Home', href: '/' }, { label: 'Privacy Policy' }]}
          title="Privacy Policy"
          lede="What Backenly collects, why, who else receives it, how long we keep it, and what happens when you ask us to delete it."
        >
          <p className="mt-7 text-[14px] text-zinc-500">
            Effective <span className="text-zinc-300">{EFFECTIVE_DATE}</span>
          </p>
        </PageHero>

        <LegalBody toc={PRIVACY_SECTIONS.map((s) => ({ id: s.id, label: s.title }))}>
          <aside aria-labelledby="short-version" className={`mb-14 p-6 md:p-8 ${PANEL}`}>
            <h2 id="short-version" className={`text-[19px] text-white ${HEADING}`}>
              The short version
            </h2>
            <ul className="mt-5 flex list-disc flex-col gap-2.5 pl-5 marker:text-zinc-600">
              {PRIVACY_SUMMARY.map((item) => (
                <li key={item} className="pl-1.5 text-[15px] leading-[1.7] text-zinc-300">
                  {item}
                </li>
              ))}
            </ul>
          </aside>

          {PRIVACY_SECTIONS.map((section) => (
            <PrivacyBlock key={section.id} section={section} />
          ))}

          <LegalFooter
            current="privacy"
            title="Privacy questions?"
            body={`Email ${PRIVACY_EMAIL} for access, deletion or any other privacy request.`}
            email={PRIVACY_EMAIL}
          />
        </LegalBody>
      </Page>
    </SiteShell>
  )
}

function PrivacyBlock({ section }: { section: PrivacySection }) {
  return (
    <LegalSection id={section.id} title={section.title}>
      <p className={LEGAL_TEXT}>{section.content}</p>

      {section.subsections && (
        <div className="grid gap-x-10 gap-y-7 border-t border-white/[0.07] pt-6 md:grid-cols-2">
          {section.subsections.map((subsection) => (
            <div key={subsection.label}>
              <h3 className={`text-[15px] text-white ${HEADING}`}>{subsection.label}</h3>
              <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 marker:text-zinc-600">
                {subsection.items.map((item) => (
                  <li key={item} className="pl-1.5 text-[15px] leading-[1.7] text-zinc-300">
                    {item}
                  </li>
                ))}
              </ul>
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
