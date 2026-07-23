'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    console.error('[Project Error]', error)
  }, [error])

  return (
    <div style={{ padding: '50px', color: 'white', background: '#0A0E1A', minHeight: '100vh', fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '28px', marginBottom: '15px', fontWeight: 'bold' }}>Project Error</h2>
        <p style={{ marginBottom: '25px', color: '#999', lineHeight: '1.6' }}>
          {error.message || 'An error occurred while loading the project'}
        </p>
        <div>
          <button
            onClick={() => reset()}
            style={{
              padding: '10px 20px',
              background: '#6366F1',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              marginRight: '10px',
            }}
          >
            Try again
          </button>
          <button
            onClick={() => router.push('/app')}
            style={{
              padding: '10px 20px',
              background: '#374151',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Go to projects
          </button>
        </div>
      </div>
    </div>
  )
}
