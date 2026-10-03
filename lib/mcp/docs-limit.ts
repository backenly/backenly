/**
 * The most of public/llms.txt that `fetch_docs` returns in one call.
 *
 * It was 24,000 characters while the file grew past 38,000, so a no-topic call
 * silently cut the guide partway through the MCP tool reference: the part an
 * agent calls it for. 40,000 characters is about 10k tokens, which fits in
 * Claude Code's default 25k-token cap on one MCP tool result.
 *
 * tests/unit/docs-tool-catalog-conformance.spec.ts holds llms.txt under this,
 * so the guide can never again be served truncated without a failing test.
 */
export const DOCS_MAX_CHARS = 40_000
