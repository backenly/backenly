'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'

export default function SeedPage() {
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSeed = async () => {
    console.log('Seed button clicked')
    setLoading(true)
    setError(null)
    setResult(null)
    
    try {
      console.log('Making POST request to /api/seed')
      const response = await fetch('/api/seed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      
      console.log('Response status:', response.status)
      const data = await response.json()
      console.log('Response data:', data)
      
      if (response.ok) {
        setResult(data)
      } else {
        setError(data.error || 'Failed to seed database')
      }
    } catch (err: any) {
      console.error('Seed error:', err)
      setError(err.message || 'Failed to seed database')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0A0E1A] flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="bg-[#111418] rounded-lg border border-[#23262B] p-8">
          <h1 className="text-2xl font-bold text-white mb-2">Database Seeder</h1>
          <p className="text-gray-400 mb-6">
            Initialize default roles, auth providers, and auth policies
          </p>
          
          <Button
            onClick={handleSeed}
            disabled={loading}
            className="w-full mb-6"
            variant="primary"
          >
            {loading ? 'Seeding Database...' : 'Seed Database'}
          </Button>
          
          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg mb-4">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}
          
          {result && (
            <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
              <p className="text-green-400 text-sm font-medium mb-2">✅ {result.message}</p>
              <div className="space-y-1 text-xs text-gray-400">
                <p>• Roles created: {result.roles}</p>
                <p>• Providers created: {result.providers}</p>
                <p>• Policies created: {result.policies}</p>
              </div>
            </div>
          )}
          
          <div className="mt-6 p-4 bg-[#181B20] rounded-lg border border-[#23262B]">
            <h3 className="text-sm font-semibold text-white mb-2">What this does:</h3>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• Creates 4 default roles (Administrator, Developer, Read-Only, AI Service)</li>
              <li>• Creates 4 auth providers (Email, Google, GitHub, Microsoft)</li>
              <li>• Creates 4 auth policies (Email Verification, Password Policy, 2FA, Session Timeout)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
