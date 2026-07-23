/**
 * Image Processing Utility
 *
 * Powered by sharp — auto-resizes, compresses, and converts images on upload.
 * Non-image files pass through unchanged.
 */

import sharp from 'sharp'

export interface ImageProcessOptions {
  /** Target width in pixels. Height scales proportionally unless height is also set. */
  width?: number
  /** Target height in pixels. Width scales proportionally unless width is also set. */
  height?: number
  /** Output format. Defaults to the original format (or 'webp' if STORAGE_IMAGE_FORMAT is set). */
  format?: 'webp' | 'jpeg' | 'png' | 'gif' | 'avif'
  /** Quality for lossy formats (1–100). Defaults to STORAGE_IMAGE_QUALITY env or 85. */
  quality?: number
  /** When true, never upscale an image beyond its original dimensions. Default: true. */
  noUpscale?: boolean
}

export interface ImageProcessResult {
  buffer: Buffer
  mimeType: string
  /** Whether processing actually happened (false = original returned unchanged) */
  processed: boolean
  originalSize: number
  finalSize: number
}

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/bmp',
])

const FORMAT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg:  'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

/**
 * Process an image buffer: resize, compress, and/or convert format.
 * Returns the original buffer unchanged for non-image files.
 */
export async function processImage(
  buffer: Buffer,
  mimeType: string,
  options: ImageProcessOptions = {}
): Promise<ImageProcessResult> {
  const originalSize = buffer.length

  // Skip non-image files
  if (!IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
    return { buffer, mimeType, processed: false, originalSize, finalSize: originalSize }
  }

  // Skip GIFs (sharp doesn't preserve animation well — keep them as-is)
  if (mimeType === 'image/gif') {
    return { buffer, mimeType, processed: false, originalSize, finalSize: originalSize }
  }

  // Resolve defaults from env
  const defaultQuality = parseInt(process.env.STORAGE_IMAGE_QUALITY || '85', 10)
  const defaultFormat = (process.env.STORAGE_IMAGE_FORMAT as ImageProcessOptions['format']) || undefined
  const globalMaxWidth = parseInt(process.env.STORAGE_IMAGE_MAX_WIDTH || '0', 10) || undefined
  const globalMaxHeight = parseInt(process.env.STORAGE_IMAGE_MAX_HEIGHT || '0', 10) || undefined

  const targetFormat = options.format ?? defaultFormat
  const quality = options.quality ?? defaultQuality
  const noUpscale = options.noUpscale ?? true

  const targetWidth = options.width ?? globalMaxWidth
  const targetHeight = options.height ?? globalMaxHeight

  try {
    let pipeline = sharp(buffer)

    // Resize if dimensions are requested
    if (targetWidth || targetHeight) {
      pipeline = pipeline.resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'inside',         // maintain aspect ratio, never crop
        withoutEnlargement: noUpscale,
      })
    }

    // Convert / compress
    let outputMime = mimeType
    if (targetFormat) {
      outputMime = FORMAT_TO_MIME[targetFormat] ?? mimeType
      switch (targetFormat) {
        case 'webp':
          pipeline = pipeline.webp({ quality })
          break
        case 'jpeg':
          pipeline = pipeline.jpeg({ quality, mozjpeg: true })
          break
        case 'png':
          pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 10) })
          break
        case 'avif':
          pipeline = pipeline.avif({ quality })
          break
      }
    } else {
      // No format change — still compress based on original type
      switch (mimeType) {
        case 'image/jpeg':
          pipeline = pipeline.jpeg({ quality, mozjpeg: true })
          break
        case 'image/png':
          pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 10) })
          break
        case 'image/webp':
          pipeline = pipeline.webp({ quality })
          break
        case 'image/avif':
          pipeline = pipeline.avif({ quality })
          break
      }
    }

    const outputBuffer = await pipeline.toBuffer()

    // Only use processed output if it's actually smaller (no-op guard)
    const finalBuffer = outputBuffer.length < buffer.length ? outputBuffer : buffer
    const finalMime = outputBuffer.length < buffer.length ? outputMime : mimeType

    return {
      buffer: finalBuffer,
      mimeType: finalMime,
      processed: true,
      originalSize,
      finalSize: finalBuffer.length,
    }
  } catch (err) {
    // If sharp fails for any reason, return original unchanged
    console.warn('[ImageProcessor] Processing failed, using original:', err)
    return { buffer, mimeType, processed: false, originalSize, finalSize: originalSize }
  }
}

/**
 * Generate the correct file extension for a given MIME type.
 * Used to update the file name when format conversion occurs.
 */
export function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png':  '.png',
    'image/gif':  '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
  }
  return map[mimeType] ?? ''
}
