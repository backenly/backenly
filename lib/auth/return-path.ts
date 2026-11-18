/**
 * Where the sign-in and sign-up pages send a person afterwards.
 *
 * Both pages take ?redirect= (an invitation link, a page that asked its
 * visitor to sign in) and go there once the person is signed in. Only a path
 * on this site is followed; anything else goes to `fallback`:
 *
 *   - another site, absolute (`https://…`) or protocol-relative (`//…`, `/\…`);
 *   - any other scheme, such as `javascript:` or `data:`;
 *   - a value with control characters or a backslash. Browsers drop tabs and
 *     newlines when they read an address, so `/<tab>/x.example` is read as
 *     `//x.example`, another site;
 *   - the sign-in pages themselves, which would send the person back to where
 *     they started.
 *
 * Read with the WHATWG URL parser against a placeholder origin, the way the
 * browser reads the value against this site, and kept only when it stays on
 * that origin. No imports, so the pages and server code can share it.
 */

const FALLBACK = '/app'
const PLACEHOLDER_ORIGIN = 'https://return-path.invalid'

export function returnPathFrom(raw: string | null | undefined, fallback: string = FALLBACK): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  // Tabs, newlines and other control characters, and backslashes, which
  // browsers read as slashes in an http(s) address.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback

  let url: URL
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback

  const path = `${url.pathname}${url.search}${url.hash}`
  if (path.startsWith('/auth') || path === '/login' || path === '/signup') return fallback
  return path
}
