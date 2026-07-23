/**
 * Storage Security Presets
 * 
 * Predefined MIME type and extension whitelists for common use cases.
 * Users can select a preset or create custom rules per bucket.
 */

export interface SecurityPreset {
  name: string
  description: string
  allowedMimeTypes: string[]
  allowedExtensions: string[]
  blockExecutables: boolean
  maxFileSizeBytes?: number // Optional per-bucket file size limit
  overwriteStrategy?: 'auto_rename' | 'version' | 'deny' | 'replace'
  isPublic?: boolean
}

export const STORAGE_SECURITY_PRESETS: Record<string, SecurityPreset> = {
  images: {
    name: 'Images Only',
    description: 'JPEG, PNG, GIF, WebP images',
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
    ],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
    blockExecutables: true,
    maxFileSizeBytes: 5 * 1024 * 1024, // 5MB for images
    overwriteStrategy: 'auto_rename',
    isPublic: true, // Images are often public
  },

  documents: {
    name: 'Documents',
    description: 'PDF, Word, Excel, PowerPoint, text files',
    allowedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
    ],
    allowedExtensions: [
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.txt',
      '.csv',
    ],
    blockExecutables: true,
    maxFileSizeBytes: 25 * 1024 * 1024, // 25MB for documents
    overwriteStrategy: 'version', // Keep document versions
    isPublic: false, // Documents often private
  },

  media: {
    name: 'Images & Videos',
    description: 'Images, videos, and audio files',
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/ogg',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
    ],
    allowedExtensions: [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.mp4',
      '.webm',
      '.ogv',
      '.mp3',
      '.wav',
      '.ogg',
    ],
    blockExecutables: true,
  },

  archives: {
    name: 'Archives',
    description: 'Compressed files (ZIP, RAR, TAR)',
    allowedMimeTypes: [
      'application/zip',
      'application/x-zip-compressed',
      'application/x-rar-compressed',
      'application/x-tar',
      'application/gzip',
    ],
    allowedExtensions: ['.zip', '.rar', '.tar', '.gz', '.7z'],
    blockExecutables: true,
  },

  unrestricted: {
    name: 'Unrestricted',
    description: 'All file types allowed (NOT RECOMMENDED)',
    allowedMimeTypes: [],
    allowedExtensions: [],
    blockExecutables: false,
  },

  strict: {
    name: 'Strict (Images + PDFs only)',
    description: 'Only images and PDF documents',
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
    ],
    allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'],
    blockExecutables: true,
  },
}

/**
 * Dangerous file extensions that should always be blocked
 */
export const DANGEROUS_EXTENSIONS = [
  // Windows executables
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.pif',
  '.scr',
  '.vbs',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.dll',
  '.lnk',

  // Unix/Linux executables
  '.sh',
  '.bash',
  '.run',
  '.bin',
  '.app',
  '.deb',
  '.rpm',
  '.so',

  // macOS executables
  '.dmg',
  '.pkg',
  '.dylib',

  // Java
  '.jar',

  // PowerShell
  '.ps1',
  '.ps2',
  '.psc1',
  '.psc2',
]

/**
 * Dangerous MIME types that should always be blocked
 */
export const DANGEROUS_MIME_TYPES = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-exe',
  'application/x-bat',
  'application/x-sh',
  'application/x-executable',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]
