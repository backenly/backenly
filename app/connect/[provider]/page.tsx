'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'

export default function ConnectProviderPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  
  const provider = params.provider as string
  const token = searchParams.get('token')
  
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('No connection token provided')
      return
    }

    // Perform handshake
    const performHandshake = async () => {
      try {
        const response = await fetch('/api/connect/handshake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, token }),
        })

        if (!response.ok) {
          throw new Error('Handshake failed')
        }

        const data = await response.json()
        
        setStatus('success')
        setMessage(`${provider.charAt(0).toUpperCase() + provider.slice(1)} connected successfully`)
        
        // Close window after 2 seconds
        setTimeout(() => {
          window.close()
        }, 2000)
      } catch (error) {
        setStatus('error')
        setMessage('Connection failed - please try again')
      }
    }

    performHandshake()
  }, [provider, token])

  return (
    <div className="min-h-screen bg-[#0B0E14] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#11151C] border border-white/[0.06] rounded-lg p-8 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="w-16 h-16 text-indigo-400 mx-auto mb-4 animate-spin" />
            <h1 className="text-xl font-bold text-white mb-2">
              Connecting to {provider.charAt(0).toUpperCase() + provider.slice(1)}
            </h1>
            <p className="text-sm text-gray-400">
              Setting up backend access...
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="w-16 h-16 text-green-400 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-white mb-2">Connected</h1>
            <p className="text-sm text-gray-400">{message}</p>
            <p className="text-xs text-gray-500 mt-4">This window will close automatically</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-white mb-2">Connection Failed</h1>
            <p className="text-sm text-gray-400">{message}</p>
            <button
              onClick={() => window.close()}
              className="mt-6 px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white rounded-lg text-sm transition-colors"
            >
              Close Window
            </button>
          </>
        )}
      </div>
    </div>
  )
}
