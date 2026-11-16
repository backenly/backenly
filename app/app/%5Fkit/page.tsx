/**
 * /app/_kit: the console's component gallery, for the people building the
 * project sections and for review. Every shared component in its states
 * (empty, error, loading, long text; phone by narrowing the window).
 *
 * The folder is `%5Fkit` because Next treats `_kit` as a private folder and
 * routes nothing in it; `%5F` is the URL-encoded underscore, so the page is
 * served at /app/_kit.
 *
 * Development only. A production build answers 404: nothing here is a
 * product surface, and its demo data must never be mistaken for a project's.
 * Like every /app page it needs a signed-in session (middleware.ts).
 */

import { Suspense } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { KitGallery } from './KitGallery'

export const metadata: Metadata = {
  title: 'Console kit',
  robots: { index: false, follow: false },
}

export default function KitPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return (
    // The gallery reads ?record= and ?dialog= from the URL.
    <Suspense>
      <KitGallery />
    </Suspense>
  )
}
