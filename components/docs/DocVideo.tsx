import type { DocVideo as DocVideoSource } from '@/app/docs/videos'

/**
 * A section's walkthrough, when app/docs/videos.ts lists one. A section with no
 * entry renders nothing in this slot: no "coming soon" frame (founders,
 * 2026-10-14, who removed every "soon" marker from the landing).
 *
 * Native controls; nothing downloads until the reader presses play
 * (preload="none" over a poster); playsInline, so iOS does not force
 * fullscreen; captions when they exist. No autoplay: this is documentation,
 * watched when the reader chooses to.
 */
export function DocVideo({ title, video }: { title: string; video: DocVideoSource }) {
  return (
    <figure className="overflow-hidden rounded-2xl border border-white/[0.07] bg-black">
      <video
        className="block aspect-video w-full"
        controls
        preload="none"
        playsInline
        poster={video.poster}
        aria-label={`${title} walkthrough`}
      >
        <source src={video.src} type="video/mp4" />
        {video.captions && <track kind="captions" src={video.captions} srcLang="en" label="English" default />}
      </video>
    </figure>
  )
}
