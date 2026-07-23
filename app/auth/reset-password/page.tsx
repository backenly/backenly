'use client'

import { useState, Suspense } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Eye, EyeOff, AlertTriangle, CheckCircle } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Logo } from '@/components/Logo'
import { GlobalLoading } from '@/components/ui/GlobalLoading'

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!token) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-[#0A0E1A] via-[#0F1419] to-[#0A0E1A] flex items-center justify-center p-8">
        <div className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-9 shadow-2xl shadow-black/50 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center mx-auto mb-6">
            <AlertTriangle className="w-8 h-8 text-red-400" />
          </div>
          <h1 className="text-2xl font-black text-white mb-3">Invalid reset link</h1>
          <p className="text-gray-400 text-sm mb-6">
            This reset link is missing a token. Please request a new one.
          </p>
          <Link
            href="/auth/forgot-password"
            className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-black rounded-2xl"
          >
            Request new link
          </Link>
        </div>
      </main>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!password) {
      setError('Password is required')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Something went wrong')
        return
      }

      setSuccess(true)
      setTimeout(() => router.push('/auth/login'), 3000)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen flex">
      {/* Left branding panel */}
      <div className="hidden lg:flex lg:w-1/3 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-600 via-purple-700 to-purple-800" />
        <motion.div
          className="absolute top-0 right-0 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl"
          animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.5, 0.3] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-0 left-0 w-96 h-96 bg-purple-400/20 rounded-full blur-3xl"
          animate={{ scale: [1.2, 1, 1.2], opacity: [0.3, 0.5, 0.3] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        />
        <div className="relative z-10 flex flex-col items-center justify-center h-full w-full px-12">
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <motion.div className="inline-flex items-center justify-center mb-16" whileHover={{ scale: 1.05 }}>
              <div className="scale-[2] mb-6">
                <Logo />
              </div>
            </motion.div>
            <h2 className="text-4xl font-bold text-white mb-4">Choose a new<br />password</h2>
            <p className="text-white/80 text-lg">Make it strong and something you'll remember.</p>
          </motion.div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 bg-gradient-to-br from-[#0A0E1A] via-[#0F1419] to-[#0A0E1A] flex items-center justify-center p-8 relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-20 right-20 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px] animate-pulse" />
          <div className="absolute bottom-20 left-20 w-96 h-96 bg-blue-500/10 rounded-full blur-[120px] animate-pulse delay-700" />
        </div>

        <div className="w-full max-w-md relative z-10">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-9 shadow-2xl shadow-black/50"
          >
            <div className="flex items-center justify-center mb-6 lg:hidden">
              <Logo />
            </div>

            {success ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center"
              >
                <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center mx-auto mb-6">
                  <CheckCircle className="w-8 h-8 text-green-400" />
                </div>
                <h1 className="text-2xl font-black text-white mb-3">Password updated</h1>
                <p className="text-gray-400 text-sm leading-relaxed mb-2">
                  Your password has been reset successfully.
                </p>
                <p className="text-gray-500 text-xs mb-6">Redirecting you to sign in...</p>
                <Link
                  href="/auth/login"
                  className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-black rounded-2xl"
                >
                  Sign in now
                </Link>
              </motion.div>
            ) : (
              <>
                <motion.div
                  className="mb-8"
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6 }}
                >
                  <h1 className="text-3xl font-black text-white mb-2 tracking-tight">New password</h1>
                  <p className="text-gray-400 text-base font-medium">
                    Must be at least 8 characters with uppercase, lowercase, and a number
                  </p>
                </motion.div>

                <motion.form
                  onSubmit={handleSubmit}
                  className="space-y-5"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                >
                  <div>
                    <label htmlFor="password" className="block text-sm font-bold text-white/70 mb-2.5 ml-1">
                      New Password
                    </label>
                    <div className="relative">
                      <input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className="w-full px-5 py-3 pr-14 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent hover:bg-white/[0.08] transition-all duration-300"
                        placeholder="••••••••"
                        disabled={isSubmitting}
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        className="absolute right-5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white transition-colors"
                      >
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="confirm" className="block text-sm font-bold text-white/70 mb-2.5 ml-1">
                      Confirm Password
                    </label>
                    <div className="relative">
                      <input
                        id="confirm"
                        type={showConfirm ? 'text' : 'password'}
                        value={confirm}
                        onChange={e => setConfirm(e.target.value)}
                        className="w-full px-5 py-3 pr-14 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent hover:bg-white/[0.08] transition-all duration-300"
                        placeholder="••••••••"
                        disabled={isSubmitting}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirm(v => !v)}
                        className="absolute right-5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white transition-colors"
                      >
                        {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-red-400 font-bold flex items-center gap-2 ml-1"
                    >
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      {error}
                    </motion.p>
                  )}

                  <motion.button
                    type="submit"
                    disabled={isSubmitting}
                    whileHover={{ scale: isSubmitting ? 1 : 1.02, y: isSubmitting ? 0 : -2 }}
                    whileTap={{ scale: isSubmitting ? 1 : 0.98 }}
                    className="w-full px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-black rounded-2xl shadow-xl shadow-purple-500/20 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden group"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
                    <span className="relative z-10">
                      {isSubmitting ? 'Updating password...' : 'Update password'}
                    </span>
                  </motion.button>
                </motion.form>

                <motion.div
                  className="mt-8 text-center"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.4 }}
                >
                  <Link
                    href="/auth/login"
                    className="text-white/60 hover:text-white transition-colors text-sm font-bold"
                  >
                    Back to sign in
                  </Link>
                </motion.div>
              </>
            )}
          </motion.div>
        </div>
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<GlobalLoading />}>
      <ResetPasswordForm />
    </Suspense>
  )
}
