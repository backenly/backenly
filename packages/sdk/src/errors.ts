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

/**
 * The error for a response that did not succeed, built from its body.
 *
 * client.request() and the storage upload both build their errors here, so
 * each keeps the API's own message, code and details, plus the HTTP status.
 * The upload used to build its own from `body.error`, which in the API's error
 * shape (`{ error: { code, message, details } }`) is an object, so the thrown
 * message read "[object Object]".
 *
 * A body with no `error` but a `message` gives that message. One that is not a
 * JSON object, or carries neither, gives "<what> failed with status <n>".
 */
export async function errorFromResponse(response: Response, what = 'Request'): Promise<BackenlyError> {
  const body: any = await response.json().catch(() => null)
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body)
  const shaped = isObject && body.error
    ? body
    : {
        error: isObject && typeof body.message === 'string' && body.message
          ? body.message
          : `${what} failed with status ${response.status}`,
        code: isObject && typeof body.code === 'string' ? body.code : undefined,
      }
  return normalizeError({ ...shaped, status: response.status })
}
