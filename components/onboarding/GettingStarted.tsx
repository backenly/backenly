'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  CheckCircle2, 
  Circle, 
  Copy, 
  Check,
  Code,
  Key,
  Database,
  Folder,
  ArrowRight,
  X,
  ExternalLink
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getProjects, type Project } from '@/lib/api/projects'
import { getApiKeys, createApiKey, type ApiKey } from '@/lib/api/apiKeys'
import { useRouter } from 'next/navigation'

interface OnboardingStep {
  id: string
  title: string
  description: string
  completed: boolean
  action?: () => void
  codeSnippet?: string
}

export function GettingStarted() {
  const router = useRouter()
  const [steps, setSteps] = useState<OnboardingStep[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [showCodeSnippet, setShowCodeSnippet] = useState<string | null>(null)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)

  useEffect(() => {
    // Check if there's a newly created API key in localStorage
    const storedApiKey = localStorage.getItem('new-api-key')
    if (storedApiKey) {
      setNewApiKey(storedApiKey)
    }
    loadOnboardingStatus()
  }, [])

  const loadOnboardingStatus = async () => {
    try {
      setLoading(true)
      const fetchedProjects = await getProjects()
      let fetchedApiKeys: ApiKey[] = []
      
      // Only fetch API keys if we have a project
      if (fetchedProjects.length > 0) {
        try {
          const apiKeysResponse = await getApiKeys()
          fetchedApiKeys = apiKeysResponse.apiKeys || []
        } catch (error) {
          // API keys might fail if no project or permissions
          console.warn('Failed to fetch API keys:', error)
        }
      }

      setProjects(fetchedProjects)
      setApiKeys(fetchedApiKeys)

      const currentProject = fetchedProjects[0]
      const publicApiKeys = fetchedApiKeys.filter(k => k.keyType === 'public')
      
      // Use the actual API key if we have it stored (from creation), otherwise use prefix
      const storedApiKey = localStorage.getItem('new-api-key')
      const apiKeyForSnippets = storedApiKey || newApiKey || (publicApiKeys.length > 0 ? publicApiKeys[0].keyPrefix + 'YOUR_KEY_HERE' : undefined)
      
      const onboardingSteps: OnboardingStep[] = [
        {
          id: 'signup',
          title: 'Sign up for Backenly',
          description: 'Create your account to get started',
          completed: true, // User is already logged in if they see this
        },
        {
          id: 'create-project',
          title: 'Create your first project',
          description: 'Set up a new backend project',
          completed: fetchedProjects.length > 0,
          action: () => router.push('/auth/project/create'),
        },
        {
          id: 'create-api-key',
          title: 'Create a public API key',
          description: 'Generate an API key to use with the SDK',
          completed: publicApiKeys.length > 0,
          action: currentProject ? () => handleCreateApiKey(currentProject.id) : undefined,
        },
        {
          id: 'install-sdk',
          title: 'Install the SDK',
          description: 'Add @backenly/js to your project',
          completed: false,
          codeSnippet: `npm install @backenly/js`,
        },
        {
          id: 'use-auth',
          title: 'Use Authentication',
          description: 'Sign up and sign in users',
          completed: false,
          codeSnippet: currentProject && apiKeyForSnippets
            ? generateAuthSnippet(currentProject.id, apiKeyForSnippets)
            : undefined,
        },
        {
          id: 'use-data',
          title: 'View Data',
          description: 'Your data is already handled',
          completed: false,
          codeSnippet: currentProject && apiKeyForSnippets
            ? generateDatabaseSnippet(currentProject.id, apiKeyForSnippets)
            : undefined,
        },
        {
          id: 'use-storage',
          title: 'View Storage',
          description: 'Your files are already handled',
          completed: false,
          codeSnippet: currentProject && apiKeyForSnippets
            ? generateStorageSnippet(currentProject.id, apiKeyForSnippets)
            : undefined,
        },
      ]

      setSteps(onboardingSteps)
    } catch (error) {
      console.error('Failed to load onboarding status:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateApiKey = async (projectId: string) => {
    try {
      // Use apiRequest directly to include projectId in header
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Id': projectId,
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`,
        },
        body: JSON.stringify({
          name: 'My First API Key',
          keyType: 'public',
          role: 'client',
          capabilities: ['database', 'auth', 'storage'],
          serviceRole: false,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create API key')
      }

      const data = await response.json()
      if (data.apiKey?.key) {
        // Store the API key in localStorage temporarily so it persists across reloads
        localStorage.setItem('new-api-key', data.apiKey.key)
        setNewApiKey(data.apiKey.key)
        await loadOnboardingStatus()
      }
    } catch (error) {
      console.error('Failed to create API key:', error)
      alert(error instanceof Error ? error.message : 'Failed to create API key. Please try again.')
    }
  }

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  const completedCount = steps.filter(s => s.completed).length
  const totalSteps = steps.length

  if (loading) {
    return (
      <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-8 shadow-2xl">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-white/10 rounded w-1/3"></div>
          <div className="h-4 bg-white/10 rounded w-2/3"></div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-8 shadow-2xl relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-purple-500/5 rounded-full blur-[80px] pointer-events-none" />
      
      <div className="flex items-center justify-between mb-8 relative z-10">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2 tracking-tight">Getting Started</h2>
          <p className="text-sm text-gray-400 font-medium">
            {completedCount} of {totalSteps} steps completed
          </p>
        </div>
        <div className="flex items-center space-x-4">
          <div className="w-40 h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
            <motion.div
              className="h-full bg-gradient-to-r from-purple-500 to-blue-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]"
              initial={{ width: 0 }}
              animate={{ width: `${(completedCount / totalSteps) * 100}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          </div>
          <span className="text-sm font-bold text-purple-400">{Math.round((completedCount / totalSteps) * 100)}%</span>
        </div>
      </div>

      {/* New API Key Modal */}
      <AnimatePresence>
        {newApiKey && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
            onClick={() => setNewApiKey(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-gradient-to-br from-[#0A0E1A] to-[#0F1419] rounded-[2.5rem] border border-purple-500/30 p-10 max-w-md w-full shadow-2xl relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-purple-500 to-blue-500" />
              
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-purple-500/20 rounded-lg">
                    <Key className="w-5 h-5 text-purple-400" />
                  </div>
                  <h3 className="text-2xl font-bold text-white tracking-tight">API Key Created!</h3>
                </div>
                <button
                  onClick={() => setNewApiKey(null)}
                  className="p-2 text-gray-500 hover:text-white hover:bg-white/5 rounded-xl transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <p className="text-sm text-gray-400 mb-6 font-medium leading-relaxed">
                Save this API key securely. For security reasons, <span className="text-purple-400 font-bold">it will not be shown again</span>.
              </p>
              
              <div className="bg-black/40 rounded-2xl p-6 border border-white/10 mb-8 group relative">
                <code className="text-sm text-purple-300 font-mono break-all leading-relaxed block text-center selection:bg-purple-500/30">
                  {newApiKey}
                </code>
              </div>
              
              <div className="flex flex-col space-y-3">
                <Button
                  variant="primary"
                  onClick={() => {
                    copyToClipboard(newApiKey, -1)
                  }}
                  className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 py-4 font-black rounded-2xl shadow-xl shadow-purple-500/20 text-white"
                >
                  {copiedIndex === -1 ? (
                    <>
                      <Check className="w-5 h-5 mr-2" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-5 h-5 mr-2" />
                      Copy Key
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setNewApiKey(null)}
                  className="w-full border-white/10 hover:bg-white/5 font-bold py-4 rounded-2xl text-white"
                >
                  I've Securely Saved It
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-4 relative z-10">
        {steps.map((step, index) => (
          <motion.div
            key={step.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className={`p-6 rounded-2xl border transition-all duration-300 ${
              step.completed
                ? 'bg-white/[0.02] border-white/5 opacity-60'
                : 'bg-white/5 border-white/10 hover:border-purple-500/30 shadow-lg'
            }`}
          >
            <div className="flex items-start space-x-5">
              <div className="flex-shrink-0 mt-1">
                {step.completed ? (
                  <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  </div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center border border-white/10 group-hover:border-purple-500/50 transition-colors">
                    <div className="w-2 h-2 rounded-full bg-gray-600 group-hover:bg-purple-400 transition-colors" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className={`text-base font-bold tracking-tight ${
                    step.completed ? 'text-gray-400 line-through' : 'text-white'
                  }`}>
                    {step.title}
                  </h3>
                  {!step.completed && step.action && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={step.action}
                      className="text-xs font-black uppercase tracking-wider text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 px-4 py-1.5 rounded-xl border border-purple-500/20"
                    >
                      Start
                      <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                    </Button>
                  )}
                </div>
                <p className="text-sm text-gray-500 font-medium mb-3">{step.description}</p>

                {/* Code Snippet */}
                {step.codeSnippet && (
                  <div className="mt-4">
                    <button
                      onClick={() => setShowCodeSnippet(
                        showCodeSnippet === step.id ? null : step.id
                      )}
                      className="flex items-center space-x-2 text-xs font-bold text-gray-500 hover:text-white transition-colors mb-3 group"
                    >
                      <Code className="w-4 h-4 text-purple-500/50 group-hover:text-purple-400" />
                      <span>
                        {showCodeSnippet === step.id ? 'Hide' : 'Show'} Example Code
                      </span>
                    </button>
                    <AnimatePresence>
                      {showCodeSnippet === step.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="relative bg-black/40 rounded-xl border border-white/5 p-5 mb-2">
                            <button
                              onClick={() => copyToClipboard(step.codeSnippet!, index)}
                              className="absolute top-3 right-3 p-2 bg-white/5 hover:bg-white/10 border border-white/5 rounded-lg transition-all group"
                              title="Copy code"
                            >
                              {copiedIndex === index ? (
                                <Check className="w-4 h-4 text-emerald-400" />
                              ) : (
                                <Copy className="w-4 h-4 text-gray-500 group-hover:text-white" />
                              )}
                            </button>
                            <pre className="text-xs text-purple-300/90 font-mono overflow-x-auto pr-12 leading-relaxed selection:bg-purple-500/30">
                              <code>{step.codeSnippet}</code>
                            </pre>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {completedCount === totalSteps && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mt-8 p-6 bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-2xl border border-purple-500/30 backdrop-blur-xl relative overflow-hidden group"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center space-x-5 relative z-10">
            <div className="w-12 h-12 bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-xl flex items-center justify-center border border-purple-500/30">
            </div>
            <div>
              <h3 className="text-lg font-bold text-white mb-1 tracking-tight">
                🎉 Everything is enabled!
              </h3>
              <p className="text-sm text-gray-400 font-medium">
                Check our{' '}
                <a
                  href="https://docs.backenly.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 underline underline-offset-4 decoration-purple-500/30 font-bold inline-flex items-center"
                >
                  developer docs
                  <ExternalLink className="w-3.5 h-3.5 ml-1" />
                </a>
                {' '}for advanced implementation guides.
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}

function generateAuthSnippet(projectId: string, apiKey: string): string {
  return `import { createClient } from '@backenly/js'

const client = createClient({
  projectId: '${projectId}',
  apiKey: '${apiKey}'
})

// Sign up a new user
const user = await client.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
  name: 'John Doe'
})

// Sign in
const session = await client.auth.signIn({
  email: 'user@example.com',
  password: 'securepassword'
})`
}

function generateDatabaseSnippet(projectId: string, apiKey: string): string {
  return `import { createClient } from '@backenly/js'

const client = createClient({
  projectId: '${projectId}',
  apiKey: '${apiKey}'
})

// Query records
const { data: users } = await client.db.table('users').select({
  where: { active: true },
  limit: 10
})

// Insert a record
const { data: newUser } = await client.db.table('users').insert({
  name: 'John Doe',
  email: 'john@example.com'
})

// Update records
await client.db.table('users').update(
  { id: 'user-id' },
  { name: 'Jane Doe' }
)`
}

function generateStorageSnippet(projectId: string, apiKey: string): string {
  return `import { createClient } from '@backenly/js'

const client = createClient({
  projectId: '${projectId}',
  apiKey: '${apiKey}'
})

// Upload a file
const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' })
const fileMetadata = await client.storage.upload({
  bucket: 'images',
  path: 'photos/photo.jpg',
  file,
  isPublic: true
})

// List files
const { data: files } = await client.storage.list({
  bucket: 'images',
  prefix: 'photos/'
})`
}

