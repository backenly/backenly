import { Metadata } from 'next'
import Link from 'next/link'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

export const metadata: Metadata = {
  title: 'Page Not Found',
  description: 'The page you are looking for does not exist. Return to Backenly and start building your backend.',
  robots: { index: false, follow: true },
}

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f0f14',
        color: '#eeeef5',
        fontFamily: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          padding: '2rem',
          maxWidth: '480px',
        }}
      >
        <p
          style={{
            fontSize: '0.8rem',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: '#8b5cf6',
            fontWeight: 600,
            marginBottom: '1.5rem',
          }}
        >
          404
        </p>

        <h1
          style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            lineHeight: 1.1,
            marginBottom: '1rem',
          }}
        >
          Page not found
        </h1>

        <p
          style={{
            fontSize: '1.05rem',
            color: '#6b6b88',
            lineHeight: 1.65,
            marginBottom: '2.5rem',
          }}
        >
          The page you are looking for does not exist or has been moved.
          Let&apos;s get you back on track.
        </p>

        <nav
          aria-label="Recovery navigation"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center' }}
        >
          <Link
            href={CLOUD_CONTROL_PLANE ? '/' : '/app'}
            style={{
              display: 'inline-block',
              background: '#7c3aed',
              color: '#fff',
              padding: '0.75rem 2rem',
              borderRadius: '8px',
              fontWeight: 600,
              fontSize: '0.95rem',
              textDecoration: 'none',
            }}
          >
            {CLOUD_CONTROL_PLANE ? 'Back to Backenly' : 'Back to your dashboard'}
          </Link>

          {/* Pricing, use cases and a signup CTA are the hosted service
              selling itself. On a self-hosted deployment the operator has
              already installed the product and these routes redirect to /app,
              so the links would be both irrelevant and circular. */}
          {CLOUD_CONTROL_PLANE && (
            <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.25rem' }}>
              <Link
                href="/pricing"
                style={{ color: '#6b6b88', fontSize: '0.9rem', textDecoration: 'none' }}
              >
                Pricing
              </Link>
              <Link
                href="/use-cases"
                style={{ color: '#6b6b88', fontSize: '0.9rem', textDecoration: 'none' }}
              >
                Use cases
              </Link>
              <Link
                href="/auth/signup"
                style={{ color: '#6b6b88', fontSize: '0.9rem', textDecoration: 'none' }}
              >
                Get started free
              </Link>
            </div>
          )}
        </nav>
      </div>
    </main>
  )
}
