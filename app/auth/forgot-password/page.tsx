'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Mail, AlertTriangle, CheckCircle, ArrowLeft } from 'lucide-react'
import { Logo } from '@/components/Logo'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!email) {
      setError('Email is required')
      return
    }

    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Something went wrong')
        return
      }

      setSubmitted(true)
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
            <h2 className="text-4xl font-bold text-white mb-4">
              Forgot your<br />password?
            </h2>
            <p className="text-white/80 text-lg">
              No worries. We'll send you a secure reset link.
            </p>
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
            {/* Logo on mobile */}
            <div className="flex items-center justify-center mb-6 lg:hidden">
              <Logo />
            </div>

            {submitted ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center"
              >
                <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center mx-auto mb-6">
                  <CheckCircle className="w-8 h-8 text-green-400" />
                </div>
                <h1 className="text-2xl font-black text-white mb-3">Check your email</h1>
                <p className="text-gray-400 text-sm leading-relaxed mb-8">
                  If <span className="text-white font-semibold">{email}</span> is registered, we sent a password reset link.
                  It expires in <span className="text-white font-semibold">1 hour</span>.
                </p>
                <p className="text-gray-500 text-xs mb-8">
                  Didn't receive it? Check your spam folder or{' '}
                  <button
                    onClick={() => setSubmitted(false)}
                    className="text-purple-400 hover:text-purple-300 underline"
                  >
                    try again
                  </button>.
                </p>
                <Link
                  href="/auth/login"
                  className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors text-sm font-bold"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
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
                  <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Reset password</h1>
                  <p className="text-gray-400 text-base font-medium">
                    Enter your email and we'll send you a reset link
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
                    <label htmlFor="email" className="block text-sm font-bold text-white/70 mb-2.5 ml-1">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30" />
                      <input
                        id="email"
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        className="w-full pl-12 pr-5 py-3 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent hover:bg-white/[0.08] transition-all duration-300"
                        placeholder="you@example.com"
                        disabled={isSubmitting}
                        autoFocus
                      />
                    </div>
                    {error && (
                      <motion.p
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-2.5 text-sm text-red-400 font-bold flex items-center gap-2 ml-1"
                      >
                        <AlertTriangle className="w-4 h-4" />
                        {error}
                      </motion.p>
                    )}
                  </div>

                  <motion.button
                    type="submit"
                    disabled={isSubmitting}
                    whileHover={{ scale: isSubmitting ? 1 : 1.02, y: isSubmitting ? 0 : -2 }}
                    whileTap={{ scale: isSubmitting ? 1 : 0.98 }}
                    className="w-full px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-black rounded-2xl shadow-xl shadow-purple-500/20 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden group"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
                    <span className="relative z-10">
                      {isSubmitting ? 'Sending link...' : 'Send reset link'}
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
                    className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors text-sm font-bold group"
                  >
                    <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
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
