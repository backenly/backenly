'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AdvancedPage() {
  const router = useRouter()

  useEffect(() => {
    // Get current project ID from localStorage
    const projectId = localStorage.getItem('current-project-id')
    
    if (projectId) {
      // Redirect to Health/Monitoring page (only remaining Inspector page)
      router.push(`/app/projects/${projectId}/monitoring`)
    } else {
      // No project, redirect to app home
      router.push('/app')
    }
  }, [router])

  return (
    <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2563EB] mx-auto mb-4"></div>
        <p className="text-sm text-[#6B7280]">Loading advanced view...</p>
      </div>
    </div>
  )
}
