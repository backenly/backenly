/**
 * Safely serialize JSON-LD for embedding in <script type="application/ld+json">.
 *
 * Why JSON.stringify alone is unsafe:
 *   The HTML parser closes <script> on any literal "</script>" — even inside a
 *   string. If user-controlled content (FAQ description, page title from a
 *   slug, etc.) ever lands in a JSON-LD blob, an attacker who can influence
 *   that field can break out of the script tag.
 *
 *   Also: U+2028 / U+2029 are valid in JSON but illegal in script bodies on
 *   older engines, producing parse errors.
 *
 * Fix: replace `<`, `>`, `&` with their unicode-escaped forms so the HTML
 * parser never sees `</script>`, and escape U+2028 / U+2029 by code point.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const LS_RE = new RegExp(LINE_SEPARATOR, 'g')
const PS_RE = new RegExp(PARAGRAPH_SEPARATOR, 'g')

export function safeJsonLd(obj: unknown): string {
  const json = JSON.stringify(obj)
  if (json === undefined) return 'null'
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LS_RE, '\\u2028')
    .replace(PS_RE, '\\u2029')
}
