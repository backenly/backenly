'use client'

import { useId, useMemo, useState } from 'react'
import { ArrowUpRight, Check, Copy } from 'lucide-react'
import { FOCUS_RING, HEADING, PANEL, PRIMARY_CTA } from '@/components/site/tokens'

const SUPPORT_EMAIL = 'support@backenly.com'

type TopicId = 'support' | 'production' | 'billing' | 'security' | 'enterprise'

type Topic = {
  id: TopicId
  label: string
  subject: string
  /** What makes a first reply possible, shown as the field's helper text. */
  include: string
  detailsLabel: string
  placeholder: string
}

/**
 * The topics a message can be about. Subjects are what the team triages on;
 * the security subject starts with SECURITY because SECURITY.md asks for
 * exactly that, and the other channels here must agree with it.
 */
const TOPICS: Topic[] = [
  {
    id: 'support',
    label: 'Product support',
    subject: 'Backenly support request',
    include: 'What you expected to happen, what happened instead, and when.',
    detailsLabel: 'What do you need help with?',
    placeholder: 'My agent created the table, but the API returns an empty list…',
  },
  {
    id: 'production',
    label: 'Production issue',
    subject: 'Backenly production issue',
    include: 'The endpoint, a timestamp, and any trace ID the dashboard shows.',
    detailsLabel: 'What is failing?',
    placeholder: 'POST /db/orders has returned 500 since 14:05 UTC, trace ID…',
  },
  {
    id: 'billing',
    label: 'Billing',
    subject: 'Backenly billing question',
    include: 'The account email, the charge date, and what looks wrong.',
    detailsLabel: 'What is the question?',
    placeholder: 'I was charged twice on September 3…',
  },
  {
    id: 'security',
    label: 'Security report',
    subject: 'SECURITY: vulnerability report',
    include: 'What you did, what happened, and what you expected. A proof of concept helps and is never required.',
    detailsLabel: 'What did you find?',
    placeholder: 'A token from one project is accepted by another when…',
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    subject: 'Backenly Enterprise',
    include: 'Your company, what you are building, expected traffic, and any compliance needs.',
    detailsLabel: 'What are you planning?',
    placeholder: 'We run a multi-tenant SaaS with about 40,000 monthly users…',
  },
]

/**
 * The message composer.
 *
 * There is no contact API behind this page, so it does not pretend to send
 * anything. It builds a mailto link from the fields and opens the visitor's own
 * email app with the message filled in; nothing leaves the browser until they
 * press send there. The link is a real anchor, recomputed as they type, so it
 * also works with middle-click, a copied link, or a keyboard.
 */
export function Composer() {
  const [topicId, setTopicId] = useState<TopicId>('support')
  const [project, setProject] = useState('')
  const [details, setDetails] = useState('')
  const [copied, setCopied] = useState(false)
  const baseId = useId()
  const topic = TOPICS.find((t) => t.id === topicId) ?? TOPICS[0]

  const href = useMemo(() => {
    const body = [
      project.trim() ? `Project: ${project.trim()}` : 'Project: ',
      '',
      details.trim() || topic.include,
      '',
    ].join('\n')
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(topic.subject)}&body=${encodeURIComponent(body)}`
  }, [project, details, topic])

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked: the address is visible and selectable */
    }
  }

  const field =
    'w-full rounded-lg border border-white/[0.10] bg-[#0b0c0f] px-4 text-[16px] text-white placeholder:text-zinc-600 transition-[border-color,box-shadow] duration-200 hover:border-white/[0.16] focus:border-violet-300/60 focus:outline-none focus:ring-2 focus:ring-violet-300/25'

  return (
    <div className={`relative overflow-hidden p-6 md:p-8 ${PANEL}`}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.55),transparent)]"
      />
      <h2 className={`text-[22px] text-white md:text-[24px] ${HEADING}`}>Write to us</h2>
      <p className="mt-2 max-w-[56ch] text-[15px] leading-[1.65] text-zinc-400">
        Pick a topic and add the details that let us solve it on the first reply.
      </p>

      <fieldset className="mt-7">
        <legend className="text-[14px] font-medium text-zinc-200">Topic</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {TOPICS.map((t) => {
            const selected = t.id === topicId
            return (
              <label
                key={t.id}
                className={`relative inline-flex h-9 cursor-pointer items-center rounded-lg border px-3.5 text-[14px] transition-colors duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-300 ${
                  selected
                    ? 'border-white bg-white font-medium text-black'
                    : 'border-white/[0.10] bg-white/[0.03] text-zinc-300 hover:border-white/20 hover:text-white'
                }`}
              >
                <input
                  type="radio"
                  name="topic"
                  value={t.id}
                  checked={selected}
                  onChange={() => setTopicId(t.id)}
                  className="sr-only"
                />
                {t.label}
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="mt-7 flex flex-col gap-2">
        <label htmlFor={`${baseId}-project`} className="text-[14px] font-medium text-zinc-200">
          Project name or ID <span className="font-normal text-zinc-500">(optional)</span>
        </label>
        <input
          id={`${baseId}-project`}
          name="project"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder="cofounder-connect…"
          className={`h-[46px] ${field}`}
        />
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <label htmlFor={`${baseId}-details`} className="text-[14px] font-medium text-zinc-200">
          {topic.detailsLabel}
        </label>
        <textarea
          id={`${baseId}-details`}
          name="details"
          rows={5}
          autoComplete="off"
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          placeholder={topic.placeholder}
          aria-describedby={`${baseId}-include`}
          className={`resize-y py-3 leading-[1.6] ${field}`}
        />
        <p id={`${baseId}-include`} className="text-[13px] leading-[1.6] text-zinc-500">
          Helps us most: {topic.include}
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
        <a href={href} className={PRIMARY_CTA}>
          Open in your email app
          <ArrowUpRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </a>
        <button
          type="button"
          onClick={copyAddress}
          className={`-ml-3 inline-flex h-[46px] cursor-pointer items-center gap-2 self-start rounded-lg px-3 text-[15px] sm:ml-0 sm:self-auto font-medium text-zinc-300 transition-colors duration-200 hover:text-white ${FOCUS_RING}`}
        >
          {copied ? <Check aria-hidden className="h-4 w-4 text-violet-300" /> : <Copy aria-hidden className="h-4 w-4" />}
          {copied ? 'Address copied' : SUPPORT_EMAIL}
        </button>
        <span aria-live="polite" className="sr-only">
          {copied ? 'Email address copied to clipboard' : ''}
        </span>
      </div>
      <p className="mt-5 text-[13px] leading-[1.6] text-zinc-500">
        This opens your own email app with the message filled in. Nothing is sent until you send it.
      </p>
    </div>
  )
}
