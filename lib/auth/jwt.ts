import jwt, { SignOptions, VerifyOptions } from 'jsonwebtoken'
import crypto from 'crypto'

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not set')
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'

// Pin algorithm — defense-in-depth against alg=none / public-key confusion
// regressions in jsonwebtoken. We sign and verify HS256 exclusively.
const ALG: SignOptions['algorithm'] = 'HS256'
const VERIFY_OPTS: VerifyOptions = { algorithms: [ALG] }

export interface JWTPayload {
  userId: string
  email: string
  name?: string
  role?: string
  provider?: string
  projectId?: string
  jti?: string
  tokenVersion?: number
}

export function generateToken(payload: JWTPayload): string {
  const payloadWithJti = {
    ...payload,
    jti: crypto.randomBytes(16).toString('hex'),
  }
  return jwt.sign(payloadWithJti, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: ALG,
  } as SignOptions)
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, VERIFY_OPTS) as JWTPayload
    return decoded
  } catch {
    return null
  }
}

export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader) return null
  if (!authHeader.startsWith('Bearer ')) return null
  return authHeader.substring(7)
}
