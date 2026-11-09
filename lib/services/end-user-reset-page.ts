/**
 * The password reset page Backenly hosts for a project's end users.
 *
 * A reset email links to the developer's app when the project has an App URL:
 * the app exchanges ?backenly_reset_token=… through auth.resetPassword().
 * Without one it links here (hostedAuthUrl in lib/services/end-user-auth-email.ts).
 * GET /auth/reset shows a form; POST /auth/reset changes the password through
 * the same flow as POST /auth/reset-password, so the two cannot disagree about
 * what a valid reset is.
 *
 * Opening the link never spends it, so a mail scanner that follows links
 * cannot use it up. Only the form's POST does, and only once.
 *
 * The page runs no script and loads nothing, and is sent with a policy that
 * keeps it that way (RESET_PAGE_HEADERS). It names the app but never links to
 * it. The runtime serves it (server/routes/auth.ts), like the verification and
 * magic link pages; on AWS, Next forwards it there through
 * app/api/v1/[projectId]/[...unmatched].
 */

import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import {
  MIN_END_USER_PASSWORD_LENGTH,
  passwordResetLinkState,
  resetEndUserPassword,
  type PasswordResetLinkState,
} from '@/lib/services/end-user-auth-flows'

export interface ResetPage {
  status: number
  html: string
}

/** Sent with every reset page: never cached, never framed, no script, no referrer. */
export const RESET_PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Robots-Tag': 'noindex',
}

const STYLE = [
  'body{margin:0;background:#0e0f13;color:#f0f0f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}',
  'main{width:100%;max-width:400px;padding:40px 24px;box-sizing:border-box}',
  '.app{color:#8b5cf6;font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 16px}',
  'h1{font-size:22px;font-weight:800;margin:0 0 8px}',
  'p{color:#9ca3af;font-size:15px;line-height:1.5;margin:0 0 24px}',
  'strong{color:#e5e7eb;font-weight:600}',
  '.field{margin:0 0 16px}',
  'label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}',
  'input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #2e313b;background:#16181e;color:#f0f0f5;font-size:15px}',
  'input[type=password]:focus{outline:2px solid #8b5cf6;outline-offset:1px}',
  '.hint{color:#9ca3af;font-size:13px;margin:6px 0 0}',
  '.error{color:#fca5a5;font-size:14px;margin:0 0 16px}',
  'button{width:100%;margin-top:8px;padding:12px;border:0;border-radius:12px;background:#8b5cf6;color:#fff;font-weight:700;font-size:15px;cursor:pointer}',
  'button:focus-visible{outline:2px solid #f0f0f5;outline-offset:2px}',
].join('')

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(appName: string, title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body><main><p class="app">${esc(appName)}</p><h1>${esc(title)}</h1>${body}</main></body></html>`
  )
}

function notice(status: number, appName: string, title: string, message: string): ResetPage {
  return { status, html: page(appName, title, `<p>${esc(message)}</p>`) }
}

function resetForm(appName: string, projectId: string, token: string, email: string, error?: string): string {
  const action = `/api/v1/${encodeURIComponent(projectId)}/auth/reset`
  return page(
    appName,
    'Choose a new password',
    `<p>For <strong>${esc(email)}</strong>.</p>` +
      (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') +
      `<form method="post" action="${esc(action)}">` +
      `<input type="hidden" name="token" value="${esc(token)}">` +
      // Lets a password manager file the new password under the right account.
      `<input type="email" name="username" value="${esc(email)}" autocomplete="username" hidden readonly>` +
      '<div class="field"><label for="password">New password</label>' +
      `<input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_END_USER_PASSWORD_LENGTH}" required aria-describedby="password-hint">` +
      `<p class="hint" id="password-hint">At least ${MIN_END_USER_PASSWORD_LENGTH} characters.</p></div>` +
      '<div class="field"><label for="confirm">Confirm new password</label>' +
      `<input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_END_USER_PASSWORD_LENGTH}" required></div>` +
      '<button type="submit">Save new password</button>' +
      '</form>',
  )
}

function linkProblem(appName: string, state: Exclude<PasswordResetLinkState['state'], 'usable'>): ResetPage {
  switch (state) {
    case 'used':
      return notice(
        400,
        appName,
        'Link already used',
        'This password reset link has already been used. If you still need to change your password, request a new reset email.',
      )
    case 'expired':
      return notice(
        400,
        appName,
        'Link expired',
        'Password reset links work for one hour. Request a new reset email and use the link in it.',
      )
    default:
      return notice(
        400,
        appName,
        'Link not valid',
        'This password reset link is incomplete, or a newer reset email replaced it. Request a new reset email and use the newest link.',
      )
  }
}

function passwordProblem(password: string, confirm: string): string | null {
  if (!password) return 'Enter a new password.'
  if (password.length < MIN_END_USER_PASSWORD_LENGTH) return `Use at least ${MIN_END_USER_PASSWORD_LENGTH} characters.`
  if (password !== confirm) return 'The two passwords don’t match.'
  return null
}

async function appNameFor(projectId: string): Promise<string> {
  return (await getAuthEmailContext(projectId).catch(() => null))?.appName ?? 'your app'
}

/** GET /auth/reset?token=…: the form, or why the link cannot be used. */
export async function resetPasswordPage(projectId: string, tokenRaw: unknown): Promise<ResetPage> {
  const appName = await appNameFor(projectId)
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : ''
  const link = await passwordResetLinkState(projectId, token)
  if (link.state !== 'usable') return linkProblem(appName, link.state)
  return { status: 200, html: resetForm(appName, projectId, token, link.email) }
}

/** POST /auth/reset: the form's submission (token, password, confirm). */
export async function submitResetPasswordForm(projectId: string, fields: Record<string, unknown>): Promise<ResetPage> {
  const appName = await appNameFor(projectId)
  const token = typeof fields.token === 'string' ? fields.token.trim() : ''
  const link = await passwordResetLinkState(projectId, token)
  if (link.state !== 'usable') return linkProblem(appName, link.state)

  const password = typeof fields.password === 'string' ? fields.password : ''
  const confirm = typeof fields.confirm === 'string' ? fields.confirm : ''
  const problem = passwordProblem(password, confirm)
  if (problem) return { status: 400, html: resetForm(appName, projectId, token, link.email, problem) }

  const result = await resetEndUserPassword(projectId, token, password)
  if (result.status === 200) {
    return notice(200, appName, 'Password changed', `You can now sign in to ${appName} with your new password.`)
  }
  if (result.status === 400) {
    // Used or expired between the check above and the reset.
    const again = await passwordResetLinkState(projectId, token)
    if (again.state !== 'usable') return linkProblem(appName, again.state)
  }
  if (result.status === 403) return notice(403, appName, 'Password not changed', 'This account has been suspended.')
  if (result.status === 404) {
    return notice(404, appName, 'Password not changed', 'The account this link was sent for no longer exists.')
  }
  return notice(
    result.status >= 500 ? result.status : 500,
    appName,
    'Password not changed',
    'Your password could not be changed right now. Try the link again in a few minutes.',
  )
}

/** A submission the recovery rate limit refused: 429 when the budget ran out, 503 when the limiter could not be asked. */
export async function throttledResetPage(projectId: string, status: 429 | 503, retryAfterSeconds: number): Promise<ResetPage> {
  const appName = await appNameFor(projectId)
  if (status === 503) {
    return notice(503, appName, 'Try again in a minute', 'Password reset is unavailable for a moment. Nothing was changed.')
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return notice(
    429,
    appName,
    'Too many attempts',
    `Too many password reset attempts came from this network. Try the link again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  )
}
