'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentProjectId } from '@/lib/api/client'

// Legacy shell-level route — forwards to the project's Connect page (§14).
// Kept (instead of deleted) because bookmarks still hit this URL.
export default function ConnectRedirect() {
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const id = await getCurrentProjectId()
      if (cancelled) return
      if (id) router.replace(`/app/projects/${id}/connect`)
      else router.replace('/app')
    })()
    return () => { cancelled = true }
  }, [router])

  return null
}
