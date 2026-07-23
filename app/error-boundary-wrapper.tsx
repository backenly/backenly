'use client'

import { ErrorBoundary } from './error-boundary'

export function ErrorBoundaryWrapper({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>
}



