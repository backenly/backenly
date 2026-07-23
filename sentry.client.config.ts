import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // 10% of transactions — keeps free tier usage low
  debug: false,
  enabled: process.env.NODE_ENV === 'production',
})
