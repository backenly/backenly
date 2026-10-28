/**
 * Read a file under public/ from server code, reliably.
 *
 * fetch_docs (app/api/mcp/tool/route.ts) and the support first responder
 * (lib/support/ai.ts) both serve the agent docs. Self-fetching the request's
 * own origin does NOT work in the Next standalone server behind the proxy: it
 * resolves to an internal origin that does not serve static files, which is how
 * fetch_docs once returned only its fallback pointer. So, in order: the file on
 * disk (public/ is copied next to the standalone server at build, and dev reads
 * it in place), the absolute app URL, then any origin the caller adds. First
 * hit wins; '' when none answers.
 *
 * `publicPath` must be one of the registry's own paths (lib/mcp/agent-docs.ts)
 * or llms.txt, never text a caller supplied.
 */
export async function readPublicDoc(publicPath: string, extraOrigins: string[] = []): Promise<string> {
  // 1. Filesystem.
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    for (const p of [
      path.join(process.cwd(), 'public', publicPath),
      path.join(process.cwd(), '.next', 'standalone', 'public', publicPath),
    ]) {
      try {
        const txt = await fs.readFile(/*turbopackIgnore: true*/ p, 'utf8')
        if (txt && txt.trim()) return txt
      } catch { /* try next path */ }
    }
  } catch { /* fs unavailable — fall through to HTTP */ }

  // 2. Absolute app URL (the proxy serves the static file there), then 3. the
  // caller's origins.
  const origins = [process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, ''), ...extraOrigins].filter(Boolean) as string[]
  for (const origin of origins) {
    try {
      const res = await fetch(`${origin}/${publicPath}`, { cache: 'no-store' })
      if (res.ok) {
        const txt = await res.text()
        if (txt && txt.trim()) return txt
      }
    } catch { /* try next origin */ }
  }
  return ''
}
