'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { ArrowRight, Loader2, Building2, Globe, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import { useRouter } from 'next/navigation'

export default function CreateOrgPage() {
  const router = useRouter()
  const [orgName, setOrgName] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const regions = [
    { value: 'us-east-1', label: 'US East (N. Virginia)' },
    { value: 'us-west-2', label: 'US West (Oregon)' },
    { value: 'eu-west-1', label: 'EU (Ireland)' },
    { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
    { value: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
  ]

  const validateOrgName = (name: string) => {
    if (!name.trim()) {
      return 'Organization name is required'
    }
    if (name.length < 3) {
      return 'Organization name must be at least 3 characters'
    }
    if (name.length > 50) {
      return 'Organization name must be less than 50 characters'
    }
    // Check for illegal characters (only letters, numbers, spaces, hyphens, underscores)
    if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) {
      return 'Organization name can only contain letters, numbers, spaces, hyphens, and underscores'
    }
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const validationError = validateOrgName(orgName)
    if (validationError) {
      setError(validationError)
      return
    }

    // Check if name is taken (simulated)
    const takenNames = ['acme', 'test', 'demo', 'example']
    const normalizedName = orgName.toLowerCase().replace(/\s+/g, '-')
    if (takenNames.includes(normalizedName)) {
      setError('This organization name is already taken. Please choose another.')
      return
    }

    setError(null)
    setIsLoading(true)
    
    // Simulate API call
    setTimeout(() => {
      setIsLoading(false)
      router.push('/auth/project/create')
    }, 1500)
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#0A0E1A] via-[#0F1419] to-[#0A0E1A] flex items-center justify-center px-6 py-12 relative overflow-hidden">
      {/* Background Blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[120px] animate-pulse"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] animate-pulse delay-700"></div>
      </div>

      <div className="w-full max-w-lg relative z-10">
        <div className="text-center mb-10">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center justify-center space-x-4 mb-8 p-4 bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] shadow-2xl"
          >
            <div className="w-14 h-14 bg-gradient-to-br from-purple-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/20">
              <span className="text-white font-black text-3xl">N</span>
            </div>
            <span className="text-3xl font-black text-white tracking-tight">Backenly</span>
          </motion.div>
          <h1 className="text-4xl font-black text-white mb-3 tracking-tight">Create Organization</h1>
          <p className="text-gray-400 text-lg font-medium">Set up your workspace to start building</p>
        </div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/5 backdrop-blur-2xl rounded-[2.5rem] p-10 border border-white/10 shadow-2xl shadow-black/50"
        >
          <form 
            className="space-y-8"
            onSubmit={handleSubmit}
          >
            <div>
              <label className="block text-sm font-bold text-white/70 mb-3 ml-1">
                Organization Name
              </label>
              <div className="relative group">
                <div className="absolute left-5 top-1/2 transform -translate-y-1/2 w-6 h-6 text-gray-500 group-focus-within:text-purple-400 transition-colors pointer-events-none">
                  <Building2 />
                </div>
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => {
                    setOrgName(e.target.value)
                    if (error) setError(null)
                  }}
                  className={`w-full pl-14 pr-6 py-4.5 bg-white/5 border rounded-2xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent hover:bg-white/[0.08] transition-all text-lg font-medium ${
                    error ? 'border-red-500' : 'border-white/10'
                  }`}
                  placeholder="e.g. Acme Corp"
                />
              </div>
              <p className="mt-3 text-xs text-gray-500 ml-1 font-medium">
                This will be used for your unique organization URL and workspace identifier.
              </p>
              {error && (
                <motion.p 
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="mt-3 text-sm text-red-400 font-bold flex items-center gap-2 ml-1"
                >
                  <AlertTriangle className="w-4 h-4" />
                  {error}
                </motion.p>
              )}
            </div>
            
            <div>
              <label className="block text-sm font-bold text-white/70 mb-3 ml-1">
                Deployment Region
              </label>
              <div className="relative group">
                <div className="absolute left-5 top-1/2 transform -translate-y-1/2 w-6 h-6 text-gray-500 group-focus-within:text-blue-400 transition-colors pointer-events-none z-10">
                  <Globe />
                </div>
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  className="w-full pl-14 pr-12 py-4.5 bg-white/5 border border-white/10 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent hover:bg-white/[0.08] transition-all appearance-none cursor-pointer text-lg font-medium"
                >
                  {regions.map((reg) => (
                    <option key={reg.value} value={reg.value} className="bg-[#0A0E1A]">
                      {reg.label}
                    </option>
                  ))}
                </select>
                <div className="absolute right-5 top-1/2 transform -translate-y-1/2 pointer-events-none text-gray-500 group-focus-within:text-blue-400 transition-colors">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
              <p className="mt-3 text-xs text-gray-500 ml-1 font-medium">
                Select the region closest to your users for the best performance.
              </p>
            </div>
            
            <motion.button 
              whileHover={{ scale: (isLoading || !orgName.trim()) ? 1 : 1.02, y: (isLoading || !orgName.trim()) ? 0 : -2 }}
              whileTap={{ scale: (isLoading || !orgName.trim()) ? 1 : 0.98 }}
              className="w-full py-5 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-black rounded-2xl shadow-xl shadow-purple-500/20 hover:shadow-2xl hover:shadow-purple-500/30 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-lg relative overflow-hidden group"
              type="submit"
              disabled={isLoading || !orgName.trim()}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000"></div>
              {isLoading ? (
                <>
                  <Loader2 className="w-6 h-6 mr-3 animate-spin" />
                  Initializing Workspace...
                </>
              ) : (
                <>
                  <span className="relative z-10 flex items-center">
                    Continue to Dashboard
                    <ArrowRight className="w-6 h-6 ml-3 group-hover:translate-x-1 transition-transform" />
                  </span>
                </>
              )}
            </motion.button>
          </form>
        </motion.div>
      </div>
    </main>
  )
}
