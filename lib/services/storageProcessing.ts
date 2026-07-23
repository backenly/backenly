/**
 * File Processing Hooks (#77)
 *
 * Triggered asynchronously after every successful file upload.
 * Each processor runs in the background — failures never block uploads.
 *
 * Processors:
 *   Images (image/*):  Generate thumbnail + extract dimensions
 *   Video  (video/*):  Extract metadata (duration, resolution, codec) via ffprobe
 *   Audio  (audio/*):  Extract metadata (duration, bitrate, sample rate)
 *   PDF    (application/pdf): Count pages (via pdf-parse when available)
 *
 * Results are stored in StorageFile.processingResult as JSON.
 * Status transitions: null → "pending" → "processing" → "complete" | "failed"
 */

import { prisma } from '@/lib/db/postgres'
import path from 'path'
import fs from 'fs/promises'

export interface ProcessingResult {
  // Image fields
  width?: number
  height?: number
  thumbnailPath?: string
  thumbnailUrl?: string
  format?: string
  // Video fields
  duration?: number     // seconds
  videoCodec?: string
  audioCodec?: string
  resolution?: string   // e.g. "1920x1080"
  frameRate?: number
  bitrate?: number
  // Audio fields
  sampleRate?: number
  channels?: number
  // PDF fields
  pageCount?: number
  // Common
  processedAt: string
}

/**
 * Enqueue processing for a newly uploaded file.
 * Non-blocking — call after the upload response has been sent.
 */
export function scheduleFileProcessing(fileId: string, filePath: string, mimeType: string): void {
  // Run as an async microtask — never awaited by the caller
  processFile(fileId, filePath, mimeType).catch((err) => {
    console.error(`[StorageProcessing] Failed for file ${fileId}:`, err)
  })
}

async function processFile(fileId: string, filePath: string, mimeType: string): Promise<void> {
  // Mark as processing
  await prisma.storageFile.update({
    where: { id: fileId },
    data: { processingStatus: 'processing' },
  })

  try {
    let result: ProcessingResult | null = null

    if (mimeType.startsWith('image/')) {
      result = await processImage(fileId, filePath, mimeType)
    } else if (mimeType.startsWith('video/')) {
      result = await processVideo(filePath)
    } else if (mimeType.startsWith('audio/')) {
      result = await processAudio(filePath)
    } else if (mimeType === 'application/pdf') {
      result = await processPdf(filePath)
    }

    if (result) {
      await prisma.storageFile.update({
        where: { id: fileId },
        data: {
          processingStatus: 'complete',
          processingResult: result as unknown as any,
        },
      })
    } else {
      // No processor for this type — mark complete with no result
      await prisma.storageFile.update({
        where: { id: fileId },
        data: { processingStatus: 'complete' },
      })
    }
  } catch (err) {
    console.error(`[StorageProcessing] Processing failed for ${fileId}:`, err)
    await prisma.storageFile.update({
      where: { id: fileId },
      data: {
        processingStatus: 'failed',
        processingResult: { error: String(err), processedAt: new Date().toISOString() } as unknown as any,
      },
    })
  }
}

// ── Image processor ───────────────────────────────────────────────────────────

async function processImage(
  fileId: string,
  filePath: string,
  mimeType: string,
): Promise<ProcessingResult> {
  const sharp = (await import('sharp')).default

  // Read original
  const buffer = await fs.readFile(filePath)
  const metadata = await sharp(buffer).metadata()

  const result: ProcessingResult = {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    processedAt: new Date().toISOString(),
  }

  // Generate 200px thumbnail
  if (
    mimeType !== 'image/gif' && // skip animated GIFs
    metadata.width &&
    metadata.height &&
    (metadata.width > 200 || metadata.height > 200)
  ) {
    const thumbDir = path.dirname(filePath)
    const thumbName = `thumb_${path.basename(filePath, path.extname(filePath))}.webp`
    const thumbPath = path.join(thumbDir, thumbName)

    await sharp(buffer)
      .resize({ width: 200, height: 200, fit: 'cover', position: 'center' })
      .webp({ quality: 75 })
      .toFile(thumbPath)

    result.thumbnailPath = thumbPath

    // Store thumbnail as a sibling file in the DB (best-effort)
    try {
      const stats = await fs.stat(thumbPath)
      const originalFile = await prisma.storageFile.findUnique({
        where: { id: fileId },
        select: { bucketId: true, projectId: true, uploadedBy: true },
      })
      if (originalFile) {
        await prisma.storageFile.create({
          data: {
            bucketId:    originalFile.bucketId,
            projectId:   originalFile.projectId,
            name:        thumbName,
            originalName: thumbName,
            path:        thumbPath,
            size:        BigInt(stats.size),
            mimeType:    'image/webp',
            isPublic:    false,
            uploadedBy:  originalFile.uploadedBy,
            processingStatus: 'complete',
          },
        })
      }
    } catch {
      // Non-fatal — thumbnail was generated but not tracked in DB
    }
  }

  return result
}

// ── Video processor ───────────────────────────────────────────────────────────

async function processVideo(filePath: string): Promise<ProcessingResult> {
  // Use fluent-ffmpeg / ffprobe if available, otherwise skip
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ])

    const probe = JSON.parse(stdout)
    const videoStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
    const audioStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
    const duration = parseFloat(probe.format?.duration ?? '0')

    return {
      duration,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : undefined,
      width: videoStream?.width,
      height: videoStream?.height,
      frameRate: videoStream?.r_frame_rate
        ? evalFraction(videoStream.r_frame_rate)
        : undefined,
      bitrate: probe.format?.bit_rate ? parseInt(probe.format.bit_rate, 10) : undefined,
      processedAt: new Date().toISOString(),
    }
  } catch {
    // ffprobe not installed or failed — return minimal result
    return { processedAt: new Date().toISOString() }
  }
}

// ── Audio processor ───────────────────────────────────────────────────────────

async function processAudio(filePath: string): Promise<ProcessingResult> {
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ])

    const probe = JSON.parse(stdout)
    const audioStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
    const duration = parseFloat(probe.format?.duration ?? '0')

    return {
      duration,
      audioCodec: audioStream?.codec_name,
      sampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : undefined,
      channels: audioStream?.channels,
      bitrate: probe.format?.bit_rate ? parseInt(probe.format.bit_rate, 10) : undefined,
      processedAt: new Date().toISOString(),
    }
  } catch {
    return { processedAt: new Date().toISOString() }
  }
}

// ── PDF processor ─────────────────────────────────────────────────────────────

async function processPdf(filePath: string): Promise<ProcessingResult> {
  try {
    // pdf-parse is optional — only available when installed.
    // The webpackIgnore comment prevents Next.js from bundling this import;
    // it falls back gracefully when the package is absent.
    const pdfParse = await import(/* webpackIgnore: true */ 'pdf-parse').then((m: any) => m.default ?? m).catch(() => null)
    if (!pdfParse) return { processedAt: new Date().toISOString() }

    const buffer = await fs.readFile(filePath)
    const data = await pdfParse(buffer)
    return {
      pageCount: data.numpages,
      processedAt: new Date().toISOString(),
    }
  } catch {
    return { processedAt: new Date().toISOString() }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function evalFraction(frac: string): number | undefined {
  const [num, den] = frac.split('/').map(Number)
  if (!den || den === 0) return num
  return Math.round((num / den) * 100) / 100
}
