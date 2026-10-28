import * as Sentry from '@sentry/nextjs'

import { scrubErrorReport, scrubReportSpan } from './lib/observability/error-report-scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.NODE_ENV,
  // No request bodies, cookies or client IPs: Sentry is a third party.
  sendDefaultPii: false,
  // Customer data never leaves in a report (lib/observability/error-report-scrub.ts).
  beforeSend: (event) => scrubErrorReport(event as any),
  beforeSendTransaction: (event) => scrubErrorReport(event as any),
  beforeSendSpan: (span) => scrubReportSpan(span as any),
})
