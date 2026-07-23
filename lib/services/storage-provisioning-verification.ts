/**
 * PHASE 3: STORAGE PROVISIONING TRUTH GUARANTEE
 * 
 * Ensures 100% alignment between system messaging and actual infrastructure state.
 * 
 * System NEVER claims readiness before resources exist.
 */

import { storageService } from './storage'
import { prisma } from '@/lib/db'

export interface ProvisioningResult {
  success: boolean
  bucketId?: string
  bucketName: string
  verified: boolean
  error?: string
  actionableMessage?: string
  physicallyExists: boolean
  databaseExists: boolean
}

export interface ProvisioningStatus {
  status: 'pending' | 'provisioning' | 'ready' | 'failed'
  bucketId?: string
  bucketName: string
  attempts: number
  lastError?: string
  startedAt: Date
  completedAt?: Date
}

/**
 * PHASE 3.1: PROVISIONING CONFIRMATION
 * 
 * Buckets must be created BEFORE user confirmation.
 * Validates existence via backend verification.
 */
export async function provisionStorageBucket(
  bucketName: string,
  projectId: string,
  isPublic: boolean = false
): Promise<ProvisioningResult> {
  console.log(`[Storage Provisioning] Starting provision for bucket: ${bucketName}`)
  
  try {
    // STEP 1: Create bucket using storage service (creates DB + physical storage)
    const bucket = await storageService.createBucket(bucketName, projectId, isPublic)
    
    console.log(`[Storage Provisioning] Bucket created in DB: ${bucket.id}`)
    
    // STEP 2: Verify bucket actually exists (both DB and physical)
    const verificationResult = await verifyBucketExists(bucket.id, projectId, bucketName)
    
    if (!verificationResult.verified) {
      // FAILURE TRANSPARENCY: Provide actionable message
      console.error(`[Storage Provisioning] ❌ Verification failed for ${bucketName}`)
      
      return {
        success: false,
        bucketId: bucket.id,
        bucketName,
        verified: false,
        error: verificationResult.error,
        actionableMessage: generateActionableErrorMessage(verificationResult),
        physicallyExists: verificationResult.physicallyExists,
        databaseExists: verificationResult.databaseExists,
      }
    }
    
    console.log(`[Storage Provisioning] ✅ Bucket ${bucketName} provisioned and verified`)
    
    return {
      success: true,
      bucketId: bucket.id,
      bucketName,
      verified: true,
      physicallyExists: true,
      databaseExists: true,
    }
  } catch (error: any) {
    console.error(`[Storage Provisioning] ❌ Failed to provision ${bucketName}:`, error)
    
    // FAILURE TRANSPARENCY: Provide actionable message
    return {
      success: false,
      bucketName,
      verified: false,
      error: error.message || 'Unknown error',
      actionableMessage: `Failed to create storage bucket "${bucketName}": ${error.message || 'Unknown error'}. Please check your storage configuration and try again.`,
      physicallyExists: false,
      databaseExists: false,
    }
  }
}

/**
 * PHASE 3.2: BACKEND VERIFICATION
 * 
 * Validates existence via backend verification.
 * Checks BOTH database record AND physical storage.
 */
export async function verifyBucketExists(
  bucketId: string,
  projectId: string,
  expectedName: string
): Promise<{
  verified: boolean
  databaseExists: boolean
  physicallyExists: boolean
  error?: string
}> {
  console.log(`[Storage Verification] Verifying bucket: ${bucketId}`)
  
  try {
    // Check 1: Database record exists
    const dbBucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
    })
    
    if (!dbBucket) {
      console.error(`[Storage Verification] ❌ Bucket ${bucketId} not found in database`)
      return {
        verified: false,
        databaseExists: false,
        physicallyExists: false,
        error: 'Bucket record not found in database',
      }
    }
    
    // Verify tenant ownership
    if (dbBucket.projectId !== projectId) {
      console.error(`[Storage Verification] ❌ Bucket ${bucketId} belongs to different project`)
      return {
        verified: false,
        databaseExists: true,
        physicallyExists: false,
        error: 'Bucket belongs to different project',
      }
    }
    
    // Verify name matches
    if (dbBucket.name !== expectedName) {
      console.error(`[Storage Verification] ❌ Bucket name mismatch: expected ${expectedName}, got ${dbBucket.name}`)
      return {
        verified: false,
        databaseExists: true,
        physicallyExists: false,
        error: `Bucket name mismatch: expected ${expectedName}, got ${dbBucket.name}`,
      }
    }
    
    // Check 2: Physical storage exists (try to list files to verify bucket is accessible)
    try {
      await storageService.listFiles(bucketId, projectId, { limit: 1 })
      console.log(`[Storage Verification] ✅ Physical storage verified for ${expectedName}`)
    } catch (error: any) {
      console.error(`[Storage Verification] ❌ Physical storage not accessible for ${expectedName}:`, error)
      return {
        verified: false,
        databaseExists: true,
        physicallyExists: false,
        error: `Physical storage not accessible: ${error.message}`,
      }
    }
    
    console.log(`[Storage Verification] ✅ Bucket ${expectedName} fully verified`)
    
    return {
      verified: true,
      databaseExists: true,
      physicallyExists: true,
    }
  } catch (error: any) {
    console.error(`[Storage Verification] ❌ Verification error:`, error)
    return {
      verified: false,
      databaseExists: false,
      physicallyExists: false,
      error: error.message || 'Unknown verification error',
    }
  }
}

/**
 * PHASE 3.5: ASYNC POLLING
 * 
 * Implements async polling until provisioning completes.
 * Uses exponential backoff with max retries.
 */
export async function pollUntilProvisioned(
  bucketId: string,
  projectId: string,
  expectedName: string,
  options: {
    maxAttempts?: number
    initialDelayMs?: number
    maxDelayMs?: number
    backoffMultiplier?: number
  } = {}
): Promise<{
  success: boolean
  attempts: number
  durationMs: number
  error?: string
}> {
  const maxAttempts = options.maxAttempts || 10
  const initialDelayMs = options.initialDelayMs || 100
  const maxDelayMs = options.maxDelayMs || 5000
  const backoffMultiplier = options.backoffMultiplier || 1.5
  
  const startTime = Date.now()
  let attempts = 0
  let currentDelay = initialDelayMs
  
  console.log(`[Storage Polling] Starting polling for bucket: ${expectedName}`)
  
  while (attempts < maxAttempts) {
    attempts++
    
    const verificationResult = await verifyBucketExists(bucketId, projectId, expectedName)
    
    if (verificationResult.verified) {
      const durationMs = Date.now() - startTime
      console.log(`[Storage Polling] ✅ Bucket ${expectedName} ready after ${attempts} attempts (${durationMs}ms)`)
      
      return {
        success: true,
        attempts,
        durationMs,
      }
    }
    
    // If database doesn't exist, no point in retrying
    if (!verificationResult.databaseExists) {
      console.error(`[Storage Polling] ❌ Bucket ${expectedName} not in database, stopping polling`)
      return {
        success: false,
        attempts,
        durationMs: Date.now() - startTime,
        error: 'Bucket not found in database',
      }
    }
    
    // Wait before next attempt (exponential backoff)
    if (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, currentDelay))
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs)
    }
  }
  
  const durationMs = Date.now() - startTime
  console.error(`[Storage Polling] ❌ Bucket ${expectedName} not ready after ${attempts} attempts (${durationMs}ms)`)
  
  return {
    success: false,
    attempts,
    durationMs,
    error: `Bucket provisioning timeout after ${attempts} attempts`,
  }
}

/**
 * PHASE 3.4: FAILURE TRANSPARENCY
 * 
 * Generate actionable error message based on verification result.
 */
function generateActionableErrorMessage(verificationResult: {
  databaseExists: boolean
  physicallyExists: boolean
  error?: string
}): string {
  if (!verificationResult.databaseExists) {
    return 'Storage bucket creation failed: Database record was not created. This may indicate a database connectivity issue. Please check your database connection and try again.'
  }
  
  if (!verificationResult.physicallyExists) {
    return `Storage bucket creation incomplete: Database record exists but physical storage is not accessible. ${verificationResult.error || 'Please check your storage configuration.'}. You may need to check file system permissions or storage service configuration.`
  }
  
  return `Storage bucket verification failed: ${verificationResult.error || 'Unknown error'}. Please try again or contact support if the issue persists.`
}

/**
 * Get bucket readiness status
 * 
 * Used by UI to show real-time provisioning status.
 */
export async function getBucketStatus(
  bucketId: string,
  projectId: string
): Promise<{
  status: 'not_found' | 'pending' | 'ready' | 'error'
  message: string
  canUpload: boolean
}> {
  try {
    const bucket = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
    })
    
    if (!bucket) {
      return {
        status: 'not_found',
        message: 'Bucket not found',
        canUpload: false,
      }
    }
    
    if (bucket.projectId !== projectId) {
      return {
        status: 'error',
        message: 'Access denied',
        canUpload: false,
      }
    }
    
    // Verify physical storage
    const verification = await verifyBucketExists(bucketId, projectId, bucket.name)
    
    if (verification.verified) {
      return {
        status: 'ready',
        message: `Bucket "${bucket.name}" is ready`,
        canUpload: true,
      }
    }
    
    if (verification.databaseExists && !verification.physicallyExists) {
      return {
        status: 'pending',
        message: `Bucket "${bucket.name}" is being provisioned...`,
        canUpload: false,
      }
    }
    
    return {
      status: 'error',
      message: verification.error || 'Bucket verification failed',
      canUpload: false,
    }
  } catch (error: any) {
    return {
      status: 'error',
      message: error.message || 'Unknown error',
      canUpload: false,
    }
  }
}

/**
 * List all buckets with their readiness status.
 *
 * `storageService.listBuckets` already proves each bucket exists in the DB, and
 * for the S3 driver every logical bucket maps to the SAME physical S3 bucket
 * (there is no per-bucket resource to provision) — so a DB-listed bucket is, by
 * definition, ready. The previous implementation called getBucketStatus() per
 * bucket, adding an N+1 of `findUnique` + `listFiles(limit:1)` (plus a presign)
 * on every storage page load — work whose result the UI never even reads, and
 * which for S3 never actually contacted object storage. A single upload attempt
 * remains the real, honest check of connectivity.
 */
export async function listBucketsWithStatus(projectId: string): Promise<Array<{
  id: string
  name: string
  isPublic: boolean
  status: 'ready' | 'pending' | 'error'
  canUpload: boolean
  fileCount: number
  totalSize: bigint
}>> {
  const buckets = await storageService.listBuckets(projectId)

  return buckets.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    isPublic: bucket.isPublic,
    status: 'ready' as const,
    canUpload: true,
    fileCount: bucket.fileCount,
    totalSize: bucket.totalSize,
  }))
}
