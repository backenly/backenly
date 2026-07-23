'use client'

/**
 * Share Preview Modal
 * 
 * Professional modal for generating shareable Cloud Preview links with:
 * - Access level controls (read-only vs full preview)
 * - Permission settings (auth endpoints, writes)
 * - Expiration time selection (24h / 72h / 7 days)
 * - User-friendly labels
 * - Copy shareable URL
 * - List & revoke existing shares
 */

import { useState, useEffect } from 'react'
import { X, Share2, Copy, Check, Trash2, ExternalLink, AlertTriangle, Clock, Shield, Lock } from 'lucide-react'

interface PreviewShare {
  id: string
  shareUrl: string
  expiresAt: string
  accessLevel: 'read_only' | 'full_preview'
  allowAuth: boolean
  allowWrites: boolean
  label?: string
  accessCount: number
  createdAt: string
}

interface SharePreviewModalProps {
  projectId: string
  isOpen: boolean
  onClose: () => void
}

export function SharePreviewModal({ projectId, isOpen, onClose }: SharePreviewModalProps) {
  const [shares, setShares] = useState<PreviewShare[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  
  // Form state
  const [accessLevel, setAccessLevel] = useState<'read_only' | 'full_preview'>('read_only')
  const [allowAuth, setAllowAuth] = useState(false)
  const [allowWrites, setAllowWrites] = useState(false)
  const [expiresInHours, setExpiresInHours] = useState(24)
  const [label, setLabel] = useState('')
  
  // Newly created share
  const [newShare, setNewShare] = useState<PreviewShare | null>(null)

  useEffect(() => {
    if (isOpen) {
      fetchShares()
    }
  }, [isOpen, projectId])

  // Auto-adjust permissions based on access level
  useEffect(() => {
    if (accessLevel === 'read_only') {
      setAllowWrites(false)
    }
  }, [accessLevel])

  const fetchShares = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/preview-shares?projectId=${projectId}`)
      if (response.ok) {
        const data = await response.json()
        setShares(data.shares || [])
      }
    } catch (error) {
      console.error('Failed to fetch shares:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateShare = async () => {
    setCreating(true)
    setNewShare(null)
    
    try {
      const response = await fetch('/api/preview-shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          accessLevel,
          allowAuth,
          allowWrites: accessLevel === 'full_preview' ? allowWrites : false,
          expiresInHours,
          label: label.trim() || undefined,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        setNewShare(data.share)
        
        // Reset form
        setAccessLevel('read_only')
        setAllowAuth(false)
        setAllowWrites(false)
        setExpiresInHours(24)
        setLabel('')
        
        // Refresh list
        fetchShares()
      } else {
        const error = await response.json()
        alert(`Failed to create share: ${error.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('Failed to create share:', error)
      alert('Failed to create share. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  const handleRevokeShare = async (shareId: string) => {
    if (!confirm('Revoke this share link? It will immediately stop working.')) {
      return
    }

    try {
      const response = await fetch(`/api/preview-shares/${shareId}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        fetchShares()
        if (newShare?.id === shareId) {
          setNewShare(null)
        }
      } else {
        alert('Failed to revoke share')
      }
    } catch (error) {
      console.error('Failed to revoke share:', error)
      alert('Failed to revoke share. Please try again.')
    }
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const formatExpiresIn = (expiresAt: string) => {
    const now = Date.now()
    const expiry = new Date(expiresAt).getTime()
    const hoursLeft = Math.max(0, Math.floor((expiry - now) / (1000 * 60 * 60)))
    
    if (hoursLeft === 0) return 'Expired'
    if (hoursLeft < 24) return `${hoursLeft}h`
    if (hoursLeft < 168) return `${Math.floor(hoursLeft / 24)}d`
    return `${Math.floor(hoursLeft / 168)}w`
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#111418] border border-[#1F2329] rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[#1F2329]">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary-500/10 rounded-lg flex items-center justify-center">
              <Share2 className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Share Cloud Preview</h2>
              <p className="text-xs text-gray-500 mt-0.5">Generate temporary shareable links</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[#1F2329] rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Success Message */}
          {newShare && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-green-400 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-green-400 mb-2">
                    ✨ Shareable link created!
                  </h3>
                  <div className="bg-[#0A0C0F] rounded-lg p-3 mb-3">
                    <div className="flex items-center justify-between">
                      <code className="text-xs text-gray-300 flex-1 break-all">{newShare.shareUrl}</code>
                      <button
                        onClick={() => copyToClipboard(newShare.shareUrl, newShare.id)}
                        className="ml-3 p-2 hover:bg-[#1F2329] rounded transition-colors shrink-0"
                      >
                        {copied === newShare.id ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">
                    Expires {formatExpiresIn(newShare.expiresAt)} • {newShare.accessLevel === 'read_only' ? 'Read-only' : 'Full preview'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Create New Share */}
          <div className="bg-[#0A0C0F] border border-[#1F2329] rounded-lg p-6">
            <h3 className="text-sm font-semibold text-white mb-4">Generate New Share Link</h3>
            
            <div className="space-y-4">
              {/* Access Level */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  Access Level
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setAccessLevel('read_only')}
                    className={`p-3 rounded-lg border-2 transition-all ${
                      accessLevel === 'read_only'
                        ? 'border-primary-500 bg-primary-500/10'
                        : 'border-[#1F2329] hover:border-[#2A2E35]'
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-1">
                      <Lock className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-medium text-white">Read-only</span>
                    </div>
                    <p className="text-xs text-gray-500">Browse APIs, run GET requests</p>
                  </button>
                  
                  <button
                    onClick={() => setAccessLevel('full_preview')}
                    className={`p-3 rounded-lg border-2 transition-all ${
                      accessLevel === 'full_preview'
                        ? 'border-primary-500 bg-primary-500/10'
                        : 'border-[#1F2329] hover:border-[#2A2E35]'
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-1">
                      <Shield className="w-4 h-4 text-green-400" />
                      <span className="text-sm font-medium text-white">Full Preview</span>
                    </div>
                    <p className="text-xs text-gray-500">POST, PUT, DELETE, uploads</p>
                  </button>
                </div>
              </div>

              {/* Permissions */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-400">
                  Permissions
                </label>
                
                <label className="flex items-center space-x-3 p-3 bg-[#111418] rounded-lg cursor-pointer hover:bg-[#1F2329] transition-colors">
                  <input
                    type="checkbox"
                    checked={allowAuth}
                    onChange={(e) => setAllowAuth(e.target.checked)}
                    className="w-4 h-4 text-primary-500 rounded focus:ring-primary-500"
                  />
                  <div className="flex-1">
                    <span className="text-sm text-white">Allow auth APIs</span>
                    <p className="text-xs text-gray-500">Enable /auth/login, /auth/register, etc.</p>
                  </div>
                </label>
                
                {accessLevel === 'full_preview' && (
                  <label className="flex items-center space-x-3 p-3 bg-[#111418] rounded-lg cursor-pointer hover:bg-[#1F2329] transition-colors">
                    <input
                      type="checkbox"
                      checked={allowWrites}
                      onChange={(e) => setAllowWrites(e.target.checked)}
                      className="w-4 h-4 text-primary-500 rounded focus:ring-primary-500"
                    />
                    <div className="flex-1">
                      <span className="text-sm text-white">Allow write operations</span>
                      <p className="text-xs text-gray-500">Enable POST, PUT, DELETE requests</p>
                    </div>
                  </label>
                )}
              </div>

              {/* Expiration */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  Expires in
                </label>
                <div className="flex space-x-2">
                  {[
                    { hours: 24, label: '24 hours' },
                    { hours: 72, label: '3 days' },
                    { hours: 168, label: '7 days' },
                  ].map(({ hours, label }) => (
                    <button
                      key={hours}
                      onClick={() => setExpiresInHours(hours)}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm transition-all ${
                        expiresInHours === hours
                          ? 'bg-primary-500 text-white'
                          : 'bg-[#1F2329] text-gray-400 hover:bg-[#2A2E35]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Label */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g., Demo for investors, Frontend team testing"
                  className="w-full px-3 py-2 bg-[#111418] border border-[#1F2329] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {/* Create Button */}
              <button
                onClick={handleCreateShare}
                disabled={creating}
                className="w-full px-4 py-3 bg-primary-500 hover:bg-primary-600 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors flex items-center justify-center space-x-2"
              >
                {creating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Creating...</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4" />
                    <span>Generate Shareable Link</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Existing Shares */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-3">Active Shares ({shares.length})</h3>
            
            {loading ? (
              <div className="text-center py-8">
                <div className="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-xs text-gray-500">Loading shares...</p>
              </div>
            ) : shares.length === 0 ? (
              <div className="bg-[#0A0C0F] border border-[#1F2329] rounded-lg p-8 text-center">
                <Share2 className="w-8 h-8 text-gray-600 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No active shares yet</p>
                <p className="text-xs text-gray-600 mt-1">Create one above to share your preview</p>
              </div>
            ) : (
              <div className="space-y-2">
                {shares.map((share) => (
                  <div
                    key={share.id}
                    className="bg-[#0A0C0F] border border-[#1F2329] rounded-lg p-4 hover:border-[#2A2E35] transition-colors"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className={`px-2 py-0.5 text-xs rounded ${
                            share.accessLevel === 'read_only'
                              ? 'bg-blue-500/20 text-blue-400'
                              : 'bg-green-500/20 text-green-400'
                          }`}>
                            {share.accessLevel === 'read_only' ? 'Read-only' : 'Full Preview'}
                          </span>
                          {share.label && (
                            <span className="text-xs text-gray-400">{share.label}</span>
                          )}
                        </div>
                        <div className="flex items-center space-x-3 text-xs text-gray-500">
                          <span className="flex items-center space-x-1">
                            <Clock className="w-3 h-3" />
                            <span>Expires {formatExpiresIn(share.expiresAt)}</span>
                          </span>
                          <span>•</span>
                          <span>{share.accessCount} accesses</span>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => copyToClipboard(share.shareUrl, share.id)}
                          className="p-2 hover:bg-[#1F2329] rounded transition-colors"
                          title="Copy link"
                        >
                          {copied === share.id ? (
                            <Check className="w-4 h-4 text-green-400" />
                          ) : (
                            <Copy className="w-4 h-4 text-gray-400" />
                          )}
                        </button>
                        <button
                          onClick={() => handleRevokeShare(share.id)}
                          className="p-2 hover:bg-red-500/10 rounded transition-colors"
                          title="Revoke share"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    </div>
                    
                    {/* URL Preview */}
                    <div className="bg-[#111418] rounded px-2 py-1 mt-2">
                      <code className="text-xs text-gray-400 break-all">{share.shareUrl}</code>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Security Notice */}
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-500">
                <p className="font-medium mb-1">Security Notice</p>
                <p className="text-amber-500/80">
                  Share links are powerful - they give full access to your preview environment. 
                  Only share with trusted people. Revoke links when no longer needed.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
