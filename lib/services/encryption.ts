/**
 * Encryption Service
 * 
 * Handles encryption/decryption of sensitive data like provider credentials
 */

import crypto from 'crypto'

// Use environment variable for encryption key
// IMPORTANT: In production, this MUST be set via ENCRYPTION_KEY environment variable
// If not set, we'll use a default (NOT SECURE - only for development!)
const getEncryptionKey = (): Buffer => {
  const key = process.env.ENCRYPTION_KEY
  if (key) {
    // If key is provided as hex string, convert it
    if (key.length === 64) {
      return Buffer.from(key, 'hex')
    }
    // Otherwise, derive a 32-byte key from the string
    return crypto.createHash('sha256').update(key).digest()
  }
  
  // Development fallback (NOT SECURE!)
  console.warn('⚠️  ENCRYPTION_KEY not set! Using default key (NOT SECURE FOR PRODUCTION!)')
  return crypto.createHash('sha256').update('backenly-dev-key-change-in-production').digest()
}

const ALGORITHM = 'aes-256-gcm'

/**
 * Encrypt sensitive data
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16)
  const key = getEncryptionKey()
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  
  const authTag = cipher.getAuthTag()
  
  // Return iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * Decrypt sensitive data
 */
export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }
  
  const [ivHex, authTagHex, encrypted] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  
  const key = getEncryptionKey()
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

/**
 * Encrypt JSON object
 */
export function encryptJSON(data: any): string {
  return encrypt(JSON.stringify(data))
}

/**
 * Decrypt JSON object
 */
export function decryptJSON(encryptedData: string): any {
  return JSON.parse(decrypt(encryptedData))
}

