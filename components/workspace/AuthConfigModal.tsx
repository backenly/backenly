'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Save, Mail, Chrome, Github } from 'lucide-react'

interface AuthConfigModalProps {
  isOpen: boolean
  onClose: () => void
  projectId: string
}

interface AuthConfig {
  providers: {
    email: boolean
    google: boolean
    github: boolean
  }
  session: {
    expiryDuration: number // hours
    refreshTokens: boolean
  }
  roles: {
    admin: boolean
    user: boolean
    editor: boolean
  }
}

export function AuthConfigModal({ isOpen, onClose, projectId }: AuthConfigModalProps) {
  const [config, setConfig] = useState<AuthConfig>({
    providers: {
      email: true,
      google: false,
      github: false,
    },
    session: {
      expiryDuration: 24,
      refreshTokens: false,
    },
    roles: {
      admin: true,
      user: true,
      editor: false,
    },
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Load existing config when modal opens
  useEffect(() => {
    if (isOpen) {
      loadConfig()
    }
  }, [isOpen])

  const loadConfig = async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/auth-config`, {
        credentials: 'include',
      })
      if (response.ok) {
        const data = await response.json()
        if (data.config) {
          setConfig(data.config)
        }
      }
    } catch (error) {
      console.error('Failed to load auth config:', error)
    }
  }

  const saveConfig = async () => {
    setSaving(true)
    setSaved(false)

    try {
      const response = await fetch(`/api/projects/${projectId}/auth-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ config }),
      })

      if (response.ok) {
        setSaved(true)
        setTimeout(() => {
          onClose()
        }, 1500)
      }
    } catch (error) {
      console.error('Failed to save auth config:', error)
    } finally {
      setSaving(false)
    }
  }

  const toggleProvider = (provider: keyof AuthConfig['providers']) => {
    setConfig({
      ...config,
      providers: {
        ...config.providers,
        [provider]: !config.providers[provider],
      },
    })
  }

  const toggleRole = (role: keyof AuthConfig['roles']) => {
    setConfig({
      ...config,
      roles: {
        ...config.roles,
        [role]: !config.roles[role],
      },
    })
  }

  const updateSession = (field: keyof AuthConfig['session'], value: any) => {
    setConfig({
      ...config,
      session: {
        ...config.session,
        [field]: value,
      },
    })
  }

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
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[80vh] bg-[#0B0F1A] border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/5">
              <div>
                <h3 className="text-lg font-semibold text-[#E6E8EF]">
                  Auth Configuration
                </h3>
                <p className="text-sm text-[#9AA3B2] mt-1">
                  Configure authentication providers and session settings
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
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Providers Section */}
              <div>
                <h4 className="text-sm font-semibold text-[#E6E8EF] mb-3">
                  Auth Providers
                </h4>
                <div className="space-y-2">
                  {/* Email/Password */}
                  <div
                    onClick={() => toggleProvider('email')}
                    className="flex items-center justify-between p-4 bg-[#151B2E]/60 border border-white/10 rounded-lg hover:border-purple-500/30 transition-all cursor-pointer"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center">
                        <Mail className="w-5 h-5 text-purple-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#E6E8EF]">Email & Password</p>
                        <p className="text-xs text-[#9AA3B2]">Traditional authentication</p>
                      </div>
                    </div>
                    <div
                      className={`w-12 h-6 rounded-full transition-colors ${
                        config.providers.email ? 'bg-purple-600' : 'bg-[#9AA3B2]/20'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
                          config.providers.email ? 'translate-x-6' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Google */}
                  <div
                    onClick={() => toggleProvider('google')}
                    className="flex items-center justify-between p-4 bg-[#151B2E]/60 border border-white/10 rounded-lg hover:border-purple-500/30 transition-all cursor-pointer"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <Chrome className="w-5 h-5 text-blue-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#E6E8EF]">Google OAuth</p>
                        <p className="text-xs text-[#9AA3B2]">Sign in with Google</p>
                      </div>
                    </div>
                    <div
                      className={`w-12 h-6 rounded-full transition-colors ${
                        config.providers.google ? 'bg-purple-600' : 'bg-[#9AA3B2]/20'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
                          config.providers.google ? 'translate-x-6' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </div>

                  {/* GitHub */}
                  <div
                    onClick={() => toggleProvider('github')}
                    className="flex items-center justify-between p-4 bg-[#151B2E]/60 border border-white/10 rounded-lg hover:border-purple-500/30 transition-all cursor-pointer"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-lg bg-gray-500/20 flex items-center justify-center">
                        <Github className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#E6E8EF]">GitHub OAuth</p>
                        <p className="text-xs text-[#9AA3B2]">Sign in with GitHub</p>
                      </div>
                    </div>
                    <div
                      className={`w-12 h-6 rounded-full transition-colors ${
                        config.providers.github ? 'bg-purple-600' : 'bg-[#9AA3B2]/20'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
                          config.providers.github ? 'translate-x-6' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Session Settings */}
              <div>
                <h4 className="text-sm font-semibold text-[#E6E8EF] mb-3">
                  Session Settings
                </h4>
                <div className="space-y-4">
                  {/* Expiry Duration */}
                  <div>
                    <label className="block text-sm font-medium text-[#E6E8EF] mb-2">
                      Session Expiry (hours)
                    </label>
                    <input
                      type="number"
                      value={config.session.expiryDuration}
                      onChange={(e) => updateSession('expiryDuration', parseInt(e.target.value) || 24)}
                      min="1"
                      max="720"
                      className="w-full px-4 py-2 bg-[#151B2E]/60 border border-white/10 rounded-lg text-[#E6E8EF] text-sm focus:outline-none focus:border-purple-500/50"
                    />
                    <p className="text-xs text-[#9AA3B2] mt-1">
                      How long users stay logged in (1-720 hours)
                    </p>
                  </div>

                  {/* Refresh Tokens */}
                  <div
                    onClick={() => updateSession('refreshTokens', !config.session.refreshTokens)}
                    className="flex items-center justify-between p-4 bg-[#151B2E]/60 border border-white/10 rounded-lg hover:border-purple-500/30 transition-all cursor-pointer"
                  >
                    <div>
                      <p className="text-sm font-medium text-[#E6E8EF]">Refresh Tokens</p>
                      <p className="text-xs text-[#9AA3B2]">Auto-renew sessions before expiry</p>
                    </div>
                    <div
                      className={`w-12 h-6 rounded-full transition-colors ${
                        config.session.refreshTokens ? 'bg-purple-600' : 'bg-[#9AA3B2]/20'
                      }`}
                    >
                      <div
                        className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
                          config.session.refreshTokens ? 'translate-x-6' : 'translate-x-0.5'
                        }`}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Role Presets */}
              <div>
                <h4 className="text-sm font-semibold text-[#E6E8EF] mb-3">
                  User Roles
                </h4>
                <div className="space-y-2">
                  {Object.entries(config.roles).map(([role, enabled]) => (
                    <div
                      key={role}
                      onClick={() => toggleRole(role as keyof AuthConfig['roles'])}
                      className="flex items-center justify-between p-3 bg-[#151B2E]/60 border border-white/10 rounded-lg hover:border-purple-500/30 transition-all cursor-pointer"
                    >
                      <span className="text-sm text-[#E6E8EF] capitalize">{role}</span>
                      <div
                        className={`w-12 h-6 rounded-full transition-colors ${
                          enabled ? 'bg-purple-600' : 'bg-[#9AA3B2]/20'
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
                            enabled ? 'translate-x-6' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-white/5">
              <button
                onClick={saveConfig}
                disabled={saving}
                className="w-full px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-600/50 disabled:cursor-not-allowed text-[#E6E8EF] text-sm font-semibold rounded-lg transition-colors flex items-center justify-center space-x-2"
              >
                {saving ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : saved ? (
                  <>
                    <Save className="w-4 h-4" />
                    <span>Saved!</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>Save Configuration</span>
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
