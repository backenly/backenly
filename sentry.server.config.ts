import * as Sentry from '@sentry/nextjs'

import { scrubErrorReport, scrubReportSpan } from './lib/observability/error-report-scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,  // 10% of transactions — keeps free tier low
  debug: false,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.NODE_ENV,
  // No request bodies, cookies or client IPs: Sentry is a third party.
  sendDefaultPii: false,

  // Ignore expected operational errors — only alert on real bugs
  ignoreErrors: [
    'Unauthorized',
    'Invalid token',
    'Project not found',
    'Table not found',
    'Rate limit exceeded',
  ],

  beforeSend(event, hint) {
    // Attach correlation ID from the request context if available
    const err = hint?.originalException as any
    if (err?.correlationId) {
      event.tags = { ...event.tags, correlation_id: err.correlationId }
    }
    // Customer data never leaves in a report (lib/observability/error-report-scrub.ts).
    return scrubErrorReport(event as any)
  },

  beforeSendTransaction(event) {
    return scrubErrorReport(event as any)
  },

  beforeSendSpan(span) {
    return scrubReportSpan(span as any)
  },
})
