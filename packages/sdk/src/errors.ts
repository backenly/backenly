/**
 * BackenlyError — the only error type the SDK ever throws.
 *
 * Carries the structured details Backenly's API returns so the developer can
 * tell *why* a request failed without reading the network tab. The most
 * useful field is `.hint`: for 401s it explains, in one line, that the bundle
 * is shipping an undefined env var (or the key is from a different project,
 * or it expired) and how to fix it. We also auto-log a console warning the
 * first time a hint-bearing error is constructed so the message appears in
 * the same DevTools tab the developer is already staring at.
 */
export class BackenlyError extends Error {
  public details?: Record<string, any>
  public hint?: string
  public fixUrl?: string

  constructor(
    message: string,
    public code?: string,
    public status?: number,
    details?: Record<string, any>,
  ) {
    super(message)
    this.name = 'BackenlyError'
    this.details = details
    this.hint = details?.hint
    this.fixUrl = details?.fixUrl

    if (typeof console !== 'undefined' && this.hint) {
      const banner = `[Backenly] ${this.code ?? 'Error'}: ${this.message}`
      const lines = [
        banner,
        '',
        this.hint,
        this.fixUrl ? `\nFix it: ${this.fixUrl}` : '',
      ].filter(Boolean).join('\n')
      console.warn(lines)
    }
  }
}

export function normalizeError(error: any): BackenlyError {
  if (error instanceof BackenlyError) return error

  // Backend shape: { error: { code, message, details, requestId } }
  if (error?.error && typeof error.error === 'object') {
    const e = error.error
    return new BackenlyError(
      e.message ?? 'Request failed',
      e.code,
      error.status,
      e.details,
    )
  }

  // Legacy shape: { error: '<string>' }
  if (typeof error?.error === 'string') {
    return new BackenlyError(error.error, error.code, error.status)
  }

  if (error?.message) return new BackenlyError(error.message)

  return new BackenlyError('An unexpected error occurred')
}
