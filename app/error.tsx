'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div style={{ padding: '50px', color: 'white', background: '#0A0E1A', minHeight: '100vh', fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '32px', marginBottom: '20px', fontWeight: 'bold' }}>Something went wrong</h1>
        <p style={{ marginBottom: '30px', color: '#888', lineHeight: '1.6' }}>
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
        <div style={{ marginBottom: '30px' }}>
          <button
            onClick={() => reset()}
            style={{
              padding: '12px 24px',
              background: '#3B82F6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: '500',
              marginRight: '10px',
              transition: 'background 0.2s',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = '#2563EB')}
            onMouseOut={(e) => (e.currentTarget.style.background = '#3B82F6')}
          >
            Try again
          </button>
          <button
            onClick={() => (window.location.href = '/')}
            style={{
              padding: '12px 24px',
              background: '#374151',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: '500',
              transition: 'background 0.2s',
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = '#1F2937')}
            onMouseOut={(e) => (e.currentTarget.style.background = '#374151')}
          >
            Go home
          </button>
        </div>
        {process.env.NODE_ENV === 'development' && (
          <pre style={{
            background: '#111',
            padding: '20px',
            borderRadius: '8px',
            overflow: 'auto',
            fontSize: '12px',
            color: '#888',
            marginTop: '30px',
            maxHeight: '300px',
          }}>
            {error.stack}
          </pre>
        )}
      </div>
    </div>
  )
}
