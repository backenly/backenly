import type { DocSlug } from './content'

/**
 * Walkthrough videos for /docs, one short film per console section.
 *
 * A section with no entry here renders nothing where the video would go, so
 * publishing a video is one line in this file and nothing else.
 *
 * To add one:
 *
 *   1. Export the walkthrough (about 20 seconds) as MP4: H.264 + AAC, 1920x1080
 *      or 1280x720, with the moov atom at the front so it starts playing before
 *      it has fully downloaded (`ffmpeg ... -movflags +faststart`).
 *   2. Export a poster frame as WebP. It is all a visitor sees until they press
 *      play, and the player downloads nothing until then (preload="none").
 *   3. Put both under public/media/docs/ with a version in the name:
 *        public/media/docs/storage-v1.mp4
 *        public/media/docs/storage-v1-poster.webp
 *      next.config.js serves /media/* as immutable for a year, so a re-cut ships
 *      as -v2. Never overwrite a published file in place: browsers that already
 *      cached it would keep the old one.
 *   4. Recommended: WebVTT captions, public/media/docs/storage-v1.en.vtt. Many
 *      people watch with the sound off.
 *   5. Add the entry below.
 *
 * Files are served from this origin because the Content-Security-Policy allows
 * media only from 'self'. A YouTube or Vimeo embed would need a frame-src change
 * in next.config.js first.
 *
 * `npm run build` fails if a listed file is missing
 * (scripts/verify-content-integrity.ts), so a typo cannot ship a broken player.
 */
export type DocVideo = {
  /** MP4 under /media/docs/. */
  src: string
  /** WebP poster frame under /media/docs/. */
  poster: string
  /** Optional WebVTT captions under /media/docs/. */
  captions?: string
}

export const DOC_VIDEOS: Partial<Record<DocSlug, DocVideo>> = {
  // storage: {
  //   src: '/media/docs/storage-v1.mp4',
  //   poster: '/media/docs/storage-v1-poster.webp',
  //   captions: '/media/docs/storage-v1.en.vtt',
  // },
}
