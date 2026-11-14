import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { Welcome } from '@/components/migrate/Welcome'
import { migrationPublished } from '@/components/migrate/flag'

/**
 * /app/welcome: the first-run question and the move flow. Answers "not found"
 * until moving a project in is published (components/migrate/flag.ts).
 */
export default function WelcomePage() {
  if (!migrationPublished()) notFound()
  // useSearchParams needs a Suspense boundary to be prerendered.
  return (
    <Suspense fallback={null}>
      <Welcome />
    </Suspense>
  )
}
