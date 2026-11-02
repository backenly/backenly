/**
 * Every provider failure as one of a few kinds, each with copy a user can be
 * shown, whether retrying could help, and whether the provider may have run
 * inference (and so may bill for it).
 *
 * `consumption` is what fair billing settles on:
 *   none     Never sent, or rejected before inference (validation, credentials,
 *            throttling). Nobody pays.
 *   ran      Inference ran and the response came back (a refusal, a cut-off
 *            answer). Its usage is attached.
 *   unknown  The request went out and the answer was lost (a timeout, a dropped
 *            connection, a server error). A timeout is not proof nothing ran.
 *
 * Only `none` failures are retried: retrying an `unknown` one could run, and be
 * billed, twice.
 */

import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAbortError,
} from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { NormalizedUsage, ProviderId } from './types'

export type AiErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'not_configured'
  | 'access_denied'
  | 'timeout'
  | 'unavailable'
  | 'invalid_request'
  | 'refused'
  | 'output_invalid'
  | 'aborted'
  | 'spend_limit'
  | 'spend_unavailable'
  | 'credits_exhausted'

export type Consumption = 'none' | 'ran' | 'unknown'

const USER_MESSAGE: Record<AiErrorKind, string> = {
  rate_limited: 'The AI provider is limiting requests right now. Try again in a minute.',
  quota_exhausted: 'The AI provider account is out of quota or credit, so AI features are unavailable until it is topped up.',
  not_configured: 'No AI provider is configured on this deployment.',
  access_denied: "The AI provider refused this deployment's credentials or access to the model.",
  timeout: 'The AI provider did not answer in time. It was not retried, because the request may already have run.',
  unavailable: 'The AI provider is unavailable right now.',
  invalid_request: 'The AI provider rejected the request as invalid.',
  refused: 'The model declined this request.',
  output_invalid: 'The model’s answer was cut off or did not match the required format.',
  aborted: 'The request was cancelled.',
  spend_limit: 'This deployment has reached its AI spending limit for the month, so the request was not sent.',
  spend_unavailable: 'AI spend could not be recorded, so the request was not sent.',
  credits_exhausted: 'This account has used its AI credits for the month.',
}

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly retryable: boolean
  readonly consumption: Consumption
  readonly provider?: ProviderId
  readonly status?: number
  /** Present when inference ran (`consumption: 'ran'`), so the run can be billed. */
  usage?: NormalizedUsage
  /** Requests sent before giving up. */
  attempts = 1
  /** The model the request was routed to, once it got that far: what prices `usage`. */
  model?: string

  constructor(
    kind: AiErrorKind,
    detail: string,
    opts: { retryable?: boolean; consumption: Consumption; provider?: ProviderId; status?: number; usage?: NormalizedUsage },
  ) {
    super(detail)
    this.name = 'AiError'
    this.kind = kind
    this.retryable = opts.retryable ?? false
    this.consumption = opts.consumption
    this.provider = opts.provider
    this.status = opts.status
    this.usage = opts.usage
  }

  /** What a person should be told. Never the provider's raw message. */
  get userMessage(): string {
    return USER_MESSAGE[this.kind]
  }
}

const QUOTA = /insufficient_quota|credit balance is too low|ServiceQuotaExceeded|billing/i

function fromStatus(status: number, message: string, code: string | undefined, provider: ProviderId): AiError {
  const base = { provider, status }
  if (QUOTA.test(message) || code === 'insufficient_quota') {
    return new AiError('quota_exhausted', message, { ...base, consumption: 'none' })
  }
  if (status === 429) return new AiError('rate_limited', message, { ...base, consumption: 'none', retryable: true })
  if (status === 401 || status === 403) return new AiError('access_denied', message, { ...base, consumption: 'none' })
  if (status === 408) return new AiError('timeout', message, { ...base, consumption: 'unknown' })
  // Overloaded or briefly unavailable: refused before any inference.
  if (status === 503 || status === 529) {
    return new AiError('unavailable', message, { ...base, consumption: 'none', retryable: true })
  }
  if (status >= 400 && status < 500) return new AiError('invalid_request', message, { ...base, consumption: 'none' })
  // Any other server error may have come after inference started.
  return new AiError('unavailable', message, { ...base, consumption: 'unknown' })
}

export function classifyProviderError(err: unknown, provider: ProviderId): AiError {
  if (err instanceof AiError) return err
  const message = err instanceof Error ? err.message : String(err)

  if (err instanceof AnthropicAbortError || err instanceof OpenAI.APIUserAbortError) {
    return new AiError('aborted', message, { provider, consumption: 'unknown' })
  }
  if (err instanceof AnthropicTimeoutError || err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiError('timeout', message, { provider, consumption: 'unknown' })
  }
  // A dropped connection may have happened before or after the request was read.
  if (err instanceof AnthropicConnectionError || err instanceof OpenAI.APIConnectionError) {
    return new AiError('unavailable', message, { provider, consumption: 'unknown' })
  }
  if (err instanceof AnthropicAPIError || err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined
    const code = err instanceof OpenAI.APIError ? (err.code ?? undefined) : undefined
    // The provider's explanation can sit in the error body rather than the message.
    const said = `${message} ${err.error ? JSON.stringify(err.error) : ''}`
    if (status !== undefined) return fromStatus(status, said, code, provider)
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AiError('aborted', message, { provider, consumption: 'unknown' })
  }
  return new AiError('unavailable', message, { provider, consumption: 'unknown' })
}

/**
 * A failure from an AWS SDK client (Bedrock Runtime's InvokeModel), which
 * throws its own error types rather than the Anthropic or OpenAI ones above.
 *
 * The SDK names each failure (`err.name`) and, when the service answered,
 * carries its status in `err.$metadata.httpStatusCode`. The name decides
 * first, because Bedrock files some failures under another kind's status
 * (ModelNotReadyException is a 429, ServiceQuotaExceededException a 400); the
 * status decides the rest, as it does for the other providers. The SDK has
 * already retried what it treats as transient, so `attempts` is what it sent.
 */
export function classifyAwsError(err: unknown, provider: ProviderId): AiError {
  if (err instanceof AiError) return err
  const message = err instanceof Error ? err.message : String(err)
  const fields = (typeof err === 'object' && err !== null ? err : {}) as {
    name?: unknown
    code?: unknown
    $metadata?: { httpStatusCode?: unknown; attempts?: unknown }
  }
  const name = typeof fields.name === 'string' ? fields.name : ''
  const status = typeof fields.$metadata?.httpStatusCode === 'number' ? fields.$metadata.httpStatusCode : undefined
  const base = { provider, status }

  const classified = ((): AiError => {
    switch (name) {
      case 'ThrottlingException':
        return new AiError('rate_limited', message, { ...base, consumption: 'none', retryable: true })
      case 'AccessDeniedException':
      // The model id does not exist in the region, or is not enabled for the account.
      case 'ResourceNotFoundException':
        return new AiError('access_denied', message, { ...base, consumption: 'none' })
      case 'ServiceQuotaExceededException':
        return new AiError('quota_exhausted', message, { ...base, consumption: 'none' })
      case 'ValidationException':
        return new AiError('invalid_request', message, { ...base, consumption: 'none' })
      // Refused before any inference: overloaded, or the model is still loading.
      case 'ServiceUnavailableException':
      case 'ModelNotReadyException':
        return new AiError('unavailable', message, { ...base, consumption: 'none', retryable: true })
      case 'ModelTimeoutException':
        return new AiError('timeout', message, { ...base, consumption: 'unknown' })
      // The model failed while it ran (a 424): the request was not at fault.
      case 'ModelErrorException':
        return new AiError('unavailable', message, { ...base, consumption: 'unknown' })
      // No AWS credentials could be found, so nothing was sent.
      case 'CredentialsProviderError':
        return new AiError('not_configured', message, { provider, consumption: 'none' })
      case 'AbortError':
        return new AiError('aborted', message, { provider, consumption: 'unknown' })
      // The SDK's HTTP/1 handler also names a reset connection or a broken pipe
      // TimeoutError; those are network failures, not a request that ran long.
      case 'TimeoutError':
        return fields.code === 'ECONNRESET' || fields.code === 'EPIPE'
          ? new AiError('unavailable', message, { provider, consumption: 'unknown' })
          : new AiError('timeout', message, { provider, consumption: 'unknown' })
    }
    if (status !== undefined) return fromStatus(status, message, undefined, provider)
    // A network failure, or anything else that got no answer from the service.
    return new AiError('unavailable', message, { provider, consumption: 'unknown' })
  })()

  if (typeof fields.$metadata?.attempts === 'number') classified.attempts = fields.$metadata.attempts
  return classified
}
