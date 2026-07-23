import rateLimit from 'express-rate-limit'

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10) // 15 minutes default
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10)

// General API rate limiter
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})

// Stricter rate limiter for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
  },
  skipSuccessfulRequests: true,
})

// Rate limiter for AI/OpenAI endpoints (more restrictive due to cost)
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Limit each IP to 50 AI requests per hour
  message: {
    error: 'Too many AI requests, please try again later.',
  },
})

// Rate limiter for file uploads
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 uploads per hour
  message: {
    error: 'Too many file uploads, please try again later.',
  },
})

// Custom rate limiter factory
export function createRateLimiter(options: {
  windowMs: number
  max: number
  message?: string
  skipSuccessfulRequests?: boolean
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    message: options.message || {
      error: 'Too many requests, please try again later.',
    },
    skipSuccessfulRequests: options.skipSuccessfulRequests || false,
    standardHeaders: true,
    legacyHeaders: false,
  })
}

