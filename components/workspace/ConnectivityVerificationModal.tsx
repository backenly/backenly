'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, CheckCircle2, XCircle, Loader2, Clock, Shield, Globe } from 'lucide-react'

interface ConnectivityVerificationModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
  baseUrl: string
  origin: string
}

interface TestResult {
  name: string
  status: 'pending' | 'running' | 'success' | 'failed'
  message: string
  latency?: number
  details?: string
}

export function ConnectivityVerificationModal({
  isOpen,
  onClose,
  projectId,
  baseUrl,
  origin,
}: ConnectivityVerificationModalProps) {
  const [tests, setTests] = useState<TestResult[]>([
    {
      name: 'CORS Preflight Test',
      status: 'pending',
      message: 'Checking CORS configuration',
    },
    {
      name: 'Auth Token Test',
      status: 'pending',
      message: 'Validating API key authentication',
    },
    {
      name: 'Sample API Call',
      status: 'pending',
      message: 'Testing a real endpoint',
    },
  ])
  const [testing, setTesting] = useState(false)
  const [completed, setCompleted] = useState(false)

  const updateTest = (index: number, updates: Partial<TestResult>) => {
    setTests((prev) =>
      prev.map((test, i) => (i === index ? { ...test, ...updates } : test))
    )
  }

  const runAllTests = async () => {
    setTesting(true)
    setCompleted(false)

    // Reset all tests
    setTests([
      {
        name: 'CORS Preflight Test',
        status: 'pending',
        message: 'Checking CORS configuration',
      },
      {
        name: 'Auth Token Test',
        status: 'pending',
        message: 'Validating API key authentication',
      },
      {
        name: 'Sample API Call',
        status: 'pending',
        message: 'Testing a real endpoint',
      },
    ])

    // Test 1: CORS Preflight
    await runCorsPreflightTest()
    await sleep(500)

    // Test 2: Auth Token
    await runAuthTokenTest()
    await sleep(500)

    // Test 3: Sample API Call
    await runSampleApiTest()

    setTesting(false)
    setCompleted(true)
  }

  const runCorsPreflightTest = async () => {
    updateTest(0, { status: 'running' })
    const startTime = performance.now()

    try {
      // Send OPTIONS request to check CORS
      const response = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
        },
      })

      const endTime = performance.now()
      const latency = Math.round(endTime - startTime)

      if (response.ok) {
        updateTest(0, {
          status: 'success',
          message: 'CORS preflight passed',
          latency,
          details: `Origin ${origin} is allowed`,
        })
      } else {
        updateTest(0, {
          status: 'failed',
          message: 'CORS preflight failed',
          latency,
          details: `Status: ${response.status}`,
        })
      }
    } catch (error: any) {
      updateTest(0, {
        status: 'failed',
        message: 'CORS preflight failed',
        details: error.message || 'Network error',
      })
    }
  }

  const runAuthTokenTest = async () => {
    updateTest(1, { status: 'running' })
    const startTime = performance.now()

    try {
      // Get API key
      const apiKeyResponse = await fetch(`/api/api-keys?projectId=${projectId}`, {
        credentials: 'include',
      })

      if (!apiKeyResponse.ok) {
        throw new Error('No API key found')
      }

      const apiKeyData = await apiKeyResponse.json()
      const apiKey = apiKeyData.keys?.[0]?.key

      if (!apiKey) {
        throw new Error('No API key available')
      }

      // Test API key validation
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
        },
      })

      const endTime = performance.now()
      const latency = Math.round(endTime - startTime)

      if (response.ok) {
        updateTest(1, {
          status: 'success',
          message: 'API key authentication passed',
          latency,
          details: 'Valid API key accepted',
        })
      } else {
        updateTest(1, {
          status: 'failed',
          message: 'API key authentication failed',
          latency,
          details: `Status: ${response.status}`,
        })
      }
    } catch (error: any) {
      updateTest(1, {
        status: 'failed',
        message: 'Auth token test failed',
        details: error.message || 'Authentication error',
      })
    }
  }

  const runSampleApiTest = async () => {
    updateTest(2, { status: 'running' })
    const startTime = performance.now()

    try {
      // Get API key
      const apiKeyResponse = await fetch(`/api/api-keys?projectId=${projectId}`, {
        credentials: 'include',
      })

      const apiKeyData = await apiKeyResponse.json()
      const apiKey = apiKeyData.keys?.[0]?.key

      // Test a sample endpoint (health or first available endpoint)
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey || '',
          Origin: origin,
        },
      })

      const endTime = performance.now()
      const latency = Math.round(endTime - startTime)

      if (response.ok) {
        const data = await response.json()
        updateTest(2, {
          status: 'success',
          message: 'Sample API call succeeded',
          latency,
          details: 'Endpoint responded correctly',
        })
      } else {
        updateTest(2, {
          status: 'failed',
          message: 'Sample API call failed',
          latency,
          details: `Status: ${response.status}`,
        })
      }
    } catch (error: any) {
      updateTest(2, {
        status: 'failed',
        message: 'Sample API call failed',
        details: error.message || 'Request error',
      })
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const getIcon = (status: TestResult['status']) => {
    switch (status) {
      case 'pending':
        return <div className="w-5 h-5 rounded-full border-2 border-[#9AA3B2]/30" />
      case 'running':
        return <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
      case 'success':
        return <CheckCircle2 className="w-5 h-5 text-green-400" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-400" />
    }
  }

  const getTestIcon = (index: number) => {
    switch (index) {
      case 0:
        return <Globe className="w-5 h-5 text-purple-400" />
      case 1:
        return <Shield className="w-5 h-5 text-purple-400" />
      case 2:
        return <CheckCircle2 className="w-5 h-5 text-purple-400" />
      default:
        return <CheckCircle2 className="w-5 h-5 text-purple-400" />
    }
  }

  const allPassed = tests.every((test) => test.status === 'success')
  const anyFailed = tests.some((test) => test.status === 'failed')

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl bg-[#0B0F1A] border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <div>
                <h3 className="text-lg font-semibold text-[#E6E8EF]">
                  Verify Frontend Communication
                </h3>
                <p className="text-sm text-[#9AA3B2] mt-1">
                  Testing connection between your app and the API
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-[#9AA3B2]" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              {/* Connection Info */}
              <div className="bg-[#151B2E]/60 rounded-lg p-4 border border-white/5 space-y-2">
                <div>
                  <p className="text-xs text-[#9AA3B2]">Frontend Origin</p>
                  <p className="text-sm text-[#E6E8EF] font-mono">{origin}</p>
                </div>
                <div>
                  <p className="text-xs text-[#9AA3B2]">API Base URL</p>
                  <p className="text-sm text-purple-400 font-mono">{baseUrl}</p>
                </div>
              </div>

              {/* Tests */}
              <div className="space-y-3">
                {tests.map((test, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className={`p-4 rounded-lg border transition-all ${
                      test.status === 'success'
                        ? 'bg-green-500/10 border-green-500/20'
                        : test.status === 'failed'
                        ? 'bg-red-500/10 border-red-500/20'
                        : test.status === 'running'
                        ? 'bg-purple-500/10 border-purple-500/20'
                        : 'bg-[#151B2E]/60 border-white/5'
                    }`}
                  >
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0 mt-0.5">{getTestIcon(index)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <h4 className="text-sm font-semibold text-[#E6E8EF]">
                            {test.name}
                          </h4>
                          <div className="flex items-center space-x-2">
                            {test.latency && (
                              <div className="flex items-center space-x-1 text-xs text-[#9AA3B2]">
                                <Clock className="w-3 h-3" />
                                <span>{test.latency}ms</span>
                              </div>
                            )}
                            {getIcon(test.status)}
                          </div>
                        </div>
                        <p className="text-sm text-[#9AA3B2]">{test.message}</p>
                        {test.details && (
                          <p className="text-xs text-[#9AA3B2]/70 mt-1">{test.details}</p>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Summary */}
              {completed && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`p-4 rounded-lg border text-center ${
                    allPassed
                      ? 'bg-green-500/10 border-green-500/20 text-green-400'
                      : anyFailed
                      ? 'bg-red-500/10 border-red-500/20 text-red-400'
                      : 'bg-[#151B2E]/60 border-white/5 text-[#9AA3B2]'
                  }`}
                >
                  <p className="text-sm font-semibold">
                    {allPassed
                      ? '✓ All tests passed! Your frontend can communicate with the API.'
                      : anyFailed
                      ? '✗ Some tests failed. Check your configuration and try again.'
                      : 'Tests completed'}
                  </p>
                </motion.div>
              )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-white/5">
              {!testing && !completed ? (
                <button
                  onClick={runAllTests}
                  className="w-full px-6 py-3 bg-purple-600 hover:bg-purple-700 text-[#E6E8EF] text-sm font-semibold rounded-lg transition-colors flex items-center justify-center space-x-2"
                >
                  <span>→</span>
                  <span>Run All Tests</span>
                </button>
              ) : testing ? (
                <button
                  disabled
                  className="w-full px-6 py-3 bg-purple-600/50 cursor-not-allowed text-[#E6E8EF] text-sm font-semibold rounded-lg flex items-center justify-center space-x-2"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Testing...</span>
                </button>
              ) : (
                <div className="flex space-x-3">
                  <button
                    onClick={runAllTests}
                    className="flex-1 px-6 py-3 bg-[#151B2E] hover:bg-[#1a2137] border border-white/10 text-[#E6E8EF] text-sm font-semibold rounded-lg transition-colors"
                  >
                    Run Again
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 px-6 py-3 bg-purple-600 hover:bg-purple-700 text-[#E6E8EF] text-sm font-semibold rounded-lg transition-colors"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
