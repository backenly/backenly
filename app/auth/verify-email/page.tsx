'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { Logo } from '@/components/Logo'

function VerifyEmailContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('No verification token provided.')
      return
    }

    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.emailVerified) {
          setStatus('success')
          setMessage(data.message || 'Email verified successfully.')
        } else {
          setStatus('error')
          setMessage(data.error || 'Verification failed.')
        }
      })
      .catch(() => {
        setStatus('error')
        setMessage('Something went wrong. Please try again.')
      })
  }, [token])

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#0A0E1A] via-[#0F1419] to-[#0A0E1A] flex items-center justify-center p-8">
      <div className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-9 shadow-2xl shadow-black/50 max-w-md w-full text-center">
        <div className="flex justify-center mb-6">
          <Logo />
        </div>

        {status === 'loading' && (
          <>
            <div className="w-16 h-16 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center mx-auto mb-6">
              <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Verifying your email…</h1>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center mx-auto mb-6">
              <CheckCircle className="w-8 h-8 text-green-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Email verified</h1>
            <p className="text-gray-400 text-sm mb-8">{message}</p>
            <Link
              href="/app"
              className="inline-block w-full py-3 px-6 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-xl hover:opacity-90 transition-opacity"
            >
              Go to dashboard
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="w-16 h-16 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center mx-auto mb-6">
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">Verification failed</h1>
            <p className="text-gray-400 text-sm mb-8">{message}</p>
            <Link
              href="/auth/login"
              className="inline-block w-full py-3 px-6 bg-white/10 text-white font-semibold rounded-xl hover:bg-white/15 transition-colors"
            >
              Back to login
            </Link>
          </>
        )}
      </div>
    </main>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  )
}
