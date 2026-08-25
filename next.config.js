/** @type {import('next').NextConfig} */
const { withSentryConfig } = require('@sentry/nextjs')

const isDevelopment = process.env.NODE_ENV !== 'production'
// challenges.cloudflare.com is REQUIRED for the Turnstile signup gate: the
// widget loads api.js (script-src) and renders inside an iframe (frame-src).
// Omitting either silently kills email signup rather than failing loudly —
// the script is blocked, no widget renders, so the client never gets a token
// and refuses to submit, while the server still demands one.
const enforcedScriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  isDevelopment ? "'unsafe-eval'" : '',
  'https://cdn.jsdelivr.net https://js.sentry-cdn.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://public.profitwell.com https://app.supademo.com https://challenges.cloudflare.com',
]
  .filter(Boolean)
  .join(' ')

const nextConfig = {
  reactStrictMode: true,

  // ── IA restructure route migration (IA restructure §14) ────────
  // Every section that moved to the single project workspace keeps a permanent
  // redirect so bookmarks, router.push call sites, and OAuth redirect URIs still
  // land. The `?hub=<section>` overlay deep links map to their new pages too, so
  // the Control Hub can be fully retired without dead links.
  async redirects() {
    const P = '/app/projects/:id'
    return [
      // Path renames / merges → first-class pages
      { source: `${P}/api-builder`, destination: `${P}/apis`, permanent: true },
      { source: `${P}/users`, destination: `${P}/auth`, permanent: true },
      { source: `${P}/memory`, destination: `${P}/autonomy`, permanent: true },
      { source: `${P}/auto-fixes`, destination: `${P}/review-queue`, permanent: true },
      // History page deleted 2026-07-18 — the Overview's agent journal is the
      // activity surface; the full ledger stays recorded server-side.
      { source: `${P}/intent-log`, destination: P, permanent: true },
      { source: `${P}/history`, destination: P, permanent: true },
      { source: `${P}/iam`, destination: `${P}/settings`, permanent: true },
      // Standalone mock Service Keys page deleted 2026-07-17 — IAM = access,
      // and the live access surface is the org Members page.
      { source: '/app/iam', destination: '/app/members', permanent: true },

      // Second in-app pricing page deleted 2026-08-07. Nothing ever linked to
      // it — it was not in the nav, the sitemap, or either guard list in
      // app/app/layout.tsx, so it rendered chrome-less and bounced anyone with
      // zero projects back to /app. It still cost real maintenance: three
      // separate pricing commits had to edit it in parallel with the billing
      // panel, and it drifted anyway (dead sales@ CTA, a "dedicated isolation"
      // claim nothing in the codebase provides, the superseded #080A0F
      // palette). The live plan chooser is the one in /app/billing.
      { source: '/app/pricing', destination: '/app/billing', permanent: true },
      { source: `${P}/mcp`, destination: `${P}/connect`, permanent: true },
      { source: `${P}/inspector/connected-apps`, destination: `${P}/connect`, permanent: true },
      { source: `${P}/inspector/deployment-status`, destination: `${P}/deploy`, permanent: true },

      // Control Hub `?hub=<section>` overlay deep links → real pages (transitional)
      { source: P, has: [{ type: 'query', key: 'hub', value: 'autonomy' }], destination: `${P}/autonomy`, permanent: false },
      { source: P, has: [{ type: 'query', key: 'hub', value: 'integrations' }], destination: `${P}/integrations`, permanent: false },
      { source: P, has: [{ type: 'query', key: 'hub', value: 'connect-frontend' }], destination: `${P}/connect`, permanent: false },
      { source: P, has: [{ type: 'query', key: 'hub', value: 'mcp' }], destination: `${P}/connect`, permanent: false },
      { source: P, has: [{ type: 'query', key: 'hub', value: 'client-keys' }], destination: `${P}/settings?tab=keys`, permanent: false },

      // /docs has no page yet; the content hub lives at /resources. Exact
      // match only — /docs/llms.txt must fall through to the rewrite below.
      { source: '/docs', destination: '/resources', permanent: false },

      // /mcp and /quickstart were two pages answering "how do I connect my
      // agent". /mcp was merged into /quickstart, then /quickstart itself was
      // removed — the connect flow lives in the product, not on a marketing
      // page. Both URLs are indexed and both are still printed as the homepage
      // of the published @backenly/mcp-server and @backenly/sdk packages, so
      // they must keep resolving. Permanent, pointing at the docs hub.
      { source: '/mcp', destination: '/resources', permanent: true },
      { source: '/quickstart', destination: '/resources', permanent: true },

      // Audience repositioning 2026-07-18: marketing slugs renamed away from
      // "vibe coders" / "non-technical founders" to agent-era audience names.
      // Old URLs are indexed — keep permanent redirects.
      { source: '/use-cases/vibe-coders', destination: '/use-cases/ai-assisted-developers', permanent: true },
      { source: '/use-cases/non-technical-founders', destination: '/use-cases/founders', permanent: true },
      { source: '/resources/how-vibe-coders-can-build-full-stack-apps-faster', destination: '/resources/full-stack-development-with-ai-coding-agents', permanent: true },
    ]
  },

  async rewrites() {
    const rules = [
      // The published CLI and older copies of the MCP setup prompt point
      // agents at /docs/llms.txt; the file is served from /llms.txt. Serve
      // it directly (no redirect) so naive fetchers get a 200.
      { source: '/docs/llms.txt', destination: '/llms.txt' },
      // OAuth discovery must live at the RFC-mandated well-known paths, but the
      // App Router will not route a literal `.well-known` directory. Rewrites
      // (not redirects) so a client reading the metadata gets a 200 at the URL
      // it derived, which is what the spec requires.
      //
      // Both the bare and the path-suffixed forms are served: RFC 9728 tells a
      // client to insert the resource path, so a resource of
      // `https://backenly.com/api/mcp` yields
      // `/.well-known/oauth-protected-resource/api/mcp`, while some hosts try
      // the bare path first. Answering only one strands the other.
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/mcp/oauth/protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/api/mcp',
        destination: '/api/mcp/oauth/protected-resource',
      },
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/mcp/oauth/authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/api/mcp',
        destination: '/api/mcp/oauth/authorization-server',
      },
    ]
    // Only proxy /api/v1/* when RUNTIME_API_URL is set. In production the
    // Next.js route handlers in app/api/v1/ serve these requests directly.
    if (process.env.RUNTIME_API_URL) {
      rules.push({
        source: '/api/v1/:path*',
        destination: `${process.env.RUNTIME_API_URL}/api/v1/:path*`,
      })
    }
    return rules
  },
  output: 'standalone',
  // Lets a deploy build into a staging directory instead of overwriting the
  // one the live process is serving from. `npm run build` rewrites .next in
  // place over minutes, and the running server resolves route chunks lazily —
  // so every request landing mid-build could hit a module that had just been
  // swapped out, returning 500 until the restart (observed 2026-07-20: real
  // 500s on /healthz and /storage/files during the build window, and the
  // reason backenly-nextjs has accumulated 300+ crash-restarts). scripts/
  // deploy.sh sets this, builds off to the side, then renames into place.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // No `eslint` key: Next 16 removed `next lint`, so the build no longer runs
  // ESLint at all and rejects the option as unrecognised. Linting is its own
  // step now, `npm run lint` -> eslint, enforced by the `static` CI job. That
  // job is what actually keeps main green; ignoreDuringBuilds meant the build
  // never enforced it anyway.
  // instrumentation.ts is loaded unconditionally since Next 15, so the
  // experimental.instrumentationHook flag that used to enable it is gone. It
  // was not a no-op to leave in place: Next 16 rejects unrecognised keys under
  // `experimental`.
  outputFileTracingIncludes: {
    '/api/**/*': ['./node_modules/.prisma/**/*'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i.pravatar.cc',
        port: '',
        pathname: '/**',
      },
    ],
  },
  async headers() {
    return [
      {
        // SDK must be publicly embeddable from any AI app-builder host.
        source: '/backenly-sdk.js',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        source: '/backenly-sdk.esm.js',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
      // /api/v1/* CORS is decided dynamically in middleware.ts so we can
      // (a) per-project allowedOrigins and (b) avoid wildcard+credentials
      // mismatch. We intentionally do NOT set Access-Control-Allow-Origin
      // here — the static wildcard was wrong.
      {
        // Landing page must always revalidate — Next.js was setting
        // s-maxage=31536000 by default which let browsers serve year-old HTML.
        source: '/',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // X-XSS-Protection removed — the legacy header is deprecated and
          // known to *introduce* XSS in some old browsers; modern browsers
          // ignore it.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Inline scripts are still required by Next.js hydration. Next
              // dev also needs eval for source maps/HMR; production keeps
              // eval disabled.
              // Migration to nonces tracked separately — the next step is
              // generating a per-request nonce in middleware and switching
              // to `'strict-dynamic'`.
              enforcedScriptSrc,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.paddle.com https://sandbox-cdn.paddle.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https: blob:",
              // Tighten connect-src — we explicitly allow Sentry, Paddle, and
              // the project's own backend. Wildcard `https:` / `wss:` removed.
              "connect-src 'self' https://api.backenly.com https://*.backenly.com https://*.ingest.sentry.io https://*.sentry.io https://api.paddle.com https://sandbox-api.paddle.com https://buy.paddle.com https://sandbox-buy.paddle.com https://api.openai.com https://*.amplitude.com wss://*.backenly.com https://challenges.cloudflare.com",
              "frame-src 'self' https://buy.paddle.com https://sandbox-buy.paddle.com https://app.supademo.com https://challenges.cloudflare.com",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
              "upgrade-insecure-requests",
            ].join('; '),
          },
          {
            // Report-only strict CSP — does NOT block anything. Browsers send
            // violation reports to Sentry/console so we can see what a future
            // nonce-based enforcement would break, without breaking the page
            // today. When violations are clean, we can promote this policy to
            // the main Content-Security-Policy header above.
            key: 'Content-Security-Policy-Report-Only',
            value: [
              "default-src 'self'",
              "script-src 'self' 'strict-dynamic' https://cdn.jsdelivr.net https://js.sentry-cdn.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://challenges.cloudflare.com",
              "style-src 'self' https://fonts.googleapis.com https://cdn.paddle.com https://sandbox-cdn.paddle.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https: blob:",
              "connect-src 'self' https://api.backenly.com https://*.backenly.com https://*.ingest.sentry.io https://*.sentry.io https://api.paddle.com https://sandbox-api.paddle.com https://buy.paddle.com https://sandbox-buy.paddle.com https://api.openai.com https://*.amplitude.com wss://*.backenly.com https://challenges.cloudflare.com",
              "frame-src 'self' https://buy.paddle.com https://sandbox-buy.paddle.com https://app.supademo.com https://challenges.cloudflare.com",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
        ],
      },
    ]
  },
}

// The Sentry webpack plugin only does anything useful at build time when a
// SENTRY_AUTH_TOKEN is present (source-map upload + release creation). With no
// token it uploads nothing but STILL phones home to sentry.io via the native
// @sentry/cli binary — and on hosts where the IPv6 route to sentry.io is dead
// (e.g. our Hetzner box) that call hangs for the full TCP timeout and freezes
// the entire `next build`. So only wrap with Sentry when a token is configured.
// Runtime error tracking (NEXT_PUBLIC_SENTRY_DSN + sentry.*.config.ts) is
// unaffected by this — it does not depend on the webpack plugin.
module.exports = process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      silent: true,
      hideSourceMaps: true,
      disableLogger: true,
    })
  : nextConfig
