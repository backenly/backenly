/**
 * WHAT AN OPERATOR MAY EDIT, AND WHAT THEY MAY PUT IN IT
 * =====================================================
 *
 * The three auth emails were real, they sent, and their subjects and bodies were
 * string literals in `lib/services/end-user-auth-email.ts`. Changing a word
 * needed a code change and a deploy, which is why the register called template
 * editing PARTIAL rather than absent.
 *
 * ── The failure mode this module exists to prevent ──────────────────────────
 *
 * "Editable templates" is a feature that can break password reset for every end
 * user of a project, silently, at the moment somebody needs it. A template with
 * a typo'd placeholder still sends — it just sends an email with no working
 * link, and nobody finds out until a support ticket arrives.
 *
 * So placeholders are an ALLOWLIST checked when the template is written, not
 * when it is sent, and the link placeholder is REQUIRED. An operator who
 * mistypes one is told at the dashboard, while they are looking at it.
 *
 * Send time then has a second line of defence: if rendering fails anyway, the
 * built-in template is used and the failure is recorded. An auth flow must never
 * be the thing that surfaces a template bug.
 */

export const TEMPLATE_KINDS = ['verification', 'password_reset', 'magic_link'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

export function isTemplateKind(value: unknown): value is TemplateKind {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value)
}

/**
 * Every value a template may interpolate.
 *
 * `ctaUrl` is the action link and is the reason the email exists.
 * `expiry` is prose ("24 hours") rather than a timestamp, because it is written
 * by the code that knows the real lifetime, and an operator typing "1 hour" into
 * a body that actually expires in 15 minutes is a support ticket with extra
 * steps.
 */
export const TEMPLATE_VARIABLES = ['appName', 'email', 'ctaUrl', 'expiry'] as const
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

/**
 * The placeholder a template cannot omit.
 *
 * A verification email without its link is not a stylistic choice, it is a
 * broken flow. Refused at save.
 */
export const REQUIRED_VARIABLES: readonly TemplateVariable[] = ['ctaUrl']

/** `{{ name }}` with optional inner whitespace. Nothing else is substituted. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export interface TemplateValidationError {
  field: 'subject' | 'bodyHtml'
  message: string
}

/** Human description of each kind, for the dashboard. */
export const KIND_LABELS: Record<TemplateKind, { title: string; sends: string }> = {
  verification: {
    title: 'Email verification',
    sends: 'Sent when an end user signs up and the project requires a verified address.',
  },
  password_reset: {
    title: 'Password reset',
    sends: 'Sent when an end user asks to reset their password.',
  },
  magic_link: {
    title: 'Magic link',
    sends: 'Sent when an end user signs in with a link instead of a password.',
  },
}

/**
 * Check a template before it is stored.
 *
 * Returns every problem rather than the first, so an operator fixing three
 * mistakes does not submit three times.
 */
export function validateTemplate(subject: string, bodyHtml: string): TemplateValidationError[] {
  const errors: TemplateValidationError[] = []

  if (!subject.trim()) {
    errors.push({ field: 'subject', message: 'A subject is required.' })
  }
  if (subject.length > 300) {
    errors.push({ field: 'subject', message: 'A subject longer than 300 characters will be truncated by mail clients.' })
  }
  if (!bodyHtml.trim()) {
    errors.push({ field: 'bodyHtml', message: 'A body is required.' })
  }
  // A ceiling, because this is stored, rendered and mailed. Not a security
  // boundary; a bound on the obvious accident of pasting an entire site in.
  if (bodyHtml.length > 100_000) {
    errors.push({ field: 'bodyHtml', message: 'The body must be under 100,000 characters.' })
  }

  for (const [field, text] of [['subject', subject], ['bodyHtml', bodyHtml]] as const) {
    for (const name of placeholdersIn(text)) {
      if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
        errors.push({
          field,
          // Named, with the alternatives. "Invalid placeholder" would leave the
          // operator guessing at a list they cannot see.
          message:
            `{{${name}}} is not a value Backenly can fill in. ` +
            `Available: ${TEMPLATE_VARIABLES.map(v => `{{${v}}}`).join(', ')}.`,
        })
      }
    }
  }

  const bodyPlaceholders = new Set(placeholdersIn(bodyHtml))
  for (const required of REQUIRED_VARIABLES) {
    if (!bodyPlaceholders.has(required)) {
      errors.push({
        field: 'bodyHtml',
        message:
          `{{${required}}} must appear in the body. Without it the email has no ` +
          `working link, which would send successfully and help nobody.`,
      })
    }
  }

  // A `{{ctaUrl}}` inside a quoted attribute is the normal case (href="..."),
  // and one inside a <script> is not something this should be carrying.
  if (/<script\b/i.test(bodyHtml)) {
    errors.push({
      field: 'bodyHtml',
      message:
        'A <script> tag is not allowed. No mail client runs it, and the preview ' +
        'renders this body, so it would only ever be a hazard here.',
    })
  }

  return errors
}

function placeholdersIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(PLACEHOLDER)) found.push(match[1])
  return found
}

/** HTML-escape a value being substituted into element content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Substitute the allowed values into a stored template.
 *
 * Every value is escaped, including `ctaUrl`. The operator writes the HTML; the
 * VALUES are data and must not be able to close an attribute or open a tag. An
 * `appName` of `"><script>` would otherwise become markup in an email the
 * project's own users open, and the same string reaches the dashboard preview.
 *
 * Unknown placeholders cannot appear here — `validateTemplate` refused them at
 * save — but one left over from an older allowlist is dropped rather than
 * printed, because `{{oldName}}` visible in a user's inbox is worse than
 * nothing.
 */
export function renderTemplate(
  template: string,
  values: Partial<Record<TemplateVariable, string>>,
): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return ''
    const value = values[name as TemplateVariable]
    return value === undefined ? '' : escapeHtml(value)
  })
}

/**
 * The same substitution for a subject line, which is plain text.
 *
 * Not HTML-escaped: a subject is not markup, and `&amp;` in somebody's inbox is
 * a bug. Newlines are stripped instead, because a newline in a subject is header
 * injection — the one thing that actually matters in this field.
 */
export function renderSubject(
  template: string,
  values: Partial<Record<TemplateVariable, string>>,
): string {
  const substituted = template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return ''
    return values[name as TemplateVariable] ?? ''
  })
  return substituted.replace(/[\r\n]+/g, ' ').trim()
}
