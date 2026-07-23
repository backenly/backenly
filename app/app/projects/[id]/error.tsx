'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react'

export default function ProjectWorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()
  const params = useParams()
  const projectId = params?.id as string

  useEffect(() => {
    console.error('[Project Workspace Error]', error)
  }, [error])

  return (
    <div style={{
      padding: '40px',
      color: 'white',
      background: '#101116',
      minHeight: '100vh',
      fontFamily: 'system-ui',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div style={{ maxWidth: '500px', width: '100%' }}>
        <div style={{
          background: '#16171d',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '12px',
          padding: '40px',
          textAlign: 'center'
        }}>
          <AlertCircle style={{ width: '48px', height: '48px', margin: '0 auto 20px', color: '#fb7185' }} />
          <h2 style={{ fontSize: '24px', marginBottom: '15px', fontWeight: 'bold' }}>
            Something went wrong
          </h2>
          <p style={{ marginBottom: '30px', color: '#a1a1aa', lineHeight: '1.6', fontSize: '14px' }}>
            {error.message || 'An error occurred in this project workspace'}
          </p>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button
              onClick={() => reset()}
              style={{
                padding: '10px 18px',
                background: 'rgba(255,255,255,0.12)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                justifyContent: 'center',
              }}
            >
              <RefreshCw style={{ width: '16px', height: '16px' }} />
              Retry
            </button>
            <button
              onClick={() => projectId && router.push(`/app/projects/${projectId}`)}
              style={{
                padding: '10px 18px',
                background: 'rgba(255,255,255,0.06)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                justifyContent: 'center',
              }}
            >
              <ArrowLeft style={{ width: '16px', height: '16px' }} />
              Overview
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
