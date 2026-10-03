'use client'

/**
 * HeroFilm — the product film under the hero headline.
 *
 * Replaced the drawn, clickable dashboard (components/landing/HeroConsole,
 * deleted 2026-09-26, last present at f997755) on an explicit product
 * decision. The film tells the whole pitch in 32 seconds, which one screen of
 * dashboard could not: an agent builds the backend over MCP, a destructive
 * request parks for a human, and at 03:12 with nobody online the loop finds a
 * dropped index, puts it back, proves it, and leaves an undoable receipt.
 *
 * THE STALENESS TRADE, taken knowingly. AutonomyFilm and the console were both
 * drawn rather than filmed because a recording of our own dashboard shipped on
 * this page once and was pulled when the product moved underneath it. That
 * risk is real here too. The contract that manages it:
 *
 *   - The film is versioned in its file names (`-v3`). A re-render ships under
 *     a NEW name (`-v4`), never over the old one: next.config.js serves
 *     /media/* as immutable, so a file replaced in place would stay stale in
 *     every browser that has already cached it for up to a year.
 *   - Re-render when anything the film shows changes shape: the shell's top
 *     bar and sidebar, the Overview (agent panel, self-healing loop, journal),
 *     the Auth and Functions pages, or the MCP tool names in the terminal.
 *   - After a re-render, re-pick OPEN_AT and the poster frame (below).
 *
 * Files, all cut from the one 1920x1110 master:
 *
 *   hero-film-v3.webm         desktop, VP9 two-pass CRF 36, 60fps, cues at the
 *                             front, ~2.6 MB. Same picture as the master at a
 *                             quarter less weight, and the only cut a Chromium
 *                             built without H.264 can play.
 *   hero-film-v3.mp4          the master itself, byte for byte (H.264 High
 *                             5.1, 60fps, ~3.5 MB, moov atom already at the
 *                             front). Everything that cannot take the WebM.
 *   hero-film-v3-1280.mp4     phones: H.264 High 4.0, 1280x740, 30fps, CRF 26,
 *                             ~1.3 MB. Every phone decodes H.264 in hardware.
 *   hero-film-v3-poster.webp  the frame at OPEN_AT
 *
 * The `codecs` in each source's type are read from the files themselves (the
 * avcC box for H.264). Re-read them after a re-render: a browser trusts the
 * string, and one that claims a level the file exceeds skips a source it could
 * have played, or picks one it cannot.
 *
 * OPENS ON THE OUTCOME, for the reason AutonomyFilm opens on its last beat.
 * The master starts and ends on the same empty "Connect your coding agent"
 * Overview (it is cut to loop), so a poster taken from frame 0 would greet
 * every visitor with an idle, empty product, which is exactly why the
 * console's idle panels were cut on 2026-09-18. For about half a second before
 * that final cross-fade the film shows the fully populated Overview instead:
 * review waiting, loop running, 100% verified. The poster is that frame, and
 * the first play seeks there, so the film opens on the result, cross-fades into
 * the empty backend on its own cut, and then shows how it got built. There is
 * no jump from poster to picture because they are the same frame.
 *
 * Reduced motion gets that same frame as a still and never autoplays; the
 * button plays it on request. Playback also stops while the frame is off
 * screen, and a visitor's own pause is never overridden by scrolling back.
 *
 * Hydration: nothing here renders differently on the client's first pass.
 * There is deliberately no `autoPlay` attribute. It would start the film
 * before React could see the reduced-motion preference, and playback starts
 * in an effect anyway, where the poster and first picture are identical.
 */

import { useEffect, useRef, useState } from 'react'
import { useInView } from 'framer-motion'
import { Pause, Play } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const FILM = {
  poster: '/media/hero-film-v3-poster.webp',
  width: 1920,
  height: 1110,
} as const

/**
 * In the order a browser should consider them; it takes the first one whose
 * `media` matches and whose `type` it can decode. Phones come first because
 * only the phone cut carries a condition. The phone cut is 30fps, but every
 * cut shares one timeline, so OPEN_AT holds for all of them.
 */
const SOURCES = [
  {
    src: '/media/hero-film-v3-1280.mp4',
    type: 'video/mp4; codecs="avc1.640028"',
    media: '(max-width: 767px)',
  },
  { src: '/media/hero-film-v3.webm', type: 'video/webm; codecs="vp9"' },
  { src: '/media/hero-film-v3.mp4', type: 'video/mp4; codecs="avc1.640033"' },
] as const satisfies readonly { src: string; type: string; media?: string }[]

/**
 * Seconds into the film where the populated Overview is fully on screen and
 * before the loop cross-fade starts (30.9s to 31.35s in v3). Measured by
 * frame difference, not by eye. The poster is the frame at this time.
 */
const OPEN_AT = 31.03

/**
 * `auto` follows the reduced-motion preference; `play` and `pause` are the
 * visitor's own choice and outrank it.
 */
type Intent = 'auto' | 'play' | 'pause'

/**
 * Starts (or resumes) the film. The first call also seeks to OPEN_AT; `opened`
 * remembers that it has, so a later resume continues where the film was.
 */
function play(video: HTMLVideoElement, opened: { current: boolean }) {
  // Autoplay policy reads the `muted` PROPERTY at play() time, and React has a
  // long history of owning that property separately from the server-rendered
  // attribute. Assert it here so the browser never sees an unmuted play.
  video.muted = true

  if (!opened.current) {
    opened.current = true
    const open = () => {
      video.currentTime = OPEN_AT
    }
    // iOS ignores `preload`, so metadata may not exist until play() asks for
    // it. Seeking on `loadedmetadata` still lands before the first frame is
    // decoded, so the poster hands straight over to the same frame.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) open()
    else video.addEventListener('loadedmetadata', open, { once: true })
  }

  // Autoplay can still be refused (iOS Low Power Mode, data saver). The film
  // then rests on its poster with the play button as the way in, which is the
  // correct outcome, so there is nothing to report.
  video.play().catch(() => {})
}

export function HeroFilm() {
  const frameRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const openedRef = useRef(false)
  const reduced = useSettledReducedMotion()
  const inView = useInView(frameRef, { amount: 0.2 })
  const [intent, setIntent] = useState<Intent>('auto')
  const [playing, setPlaying] = useState(false)

  const shouldPlay = inView && (intent === 'play' || (intent === 'auto' && !reduced))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shouldPlay) play(video, openedRef)
    else video.pause()
  }, [shouldPlay])

  function toggle() {
    const video = videoRef.current
    if (!video) return

    // Drive the element directly as well as through state: a refused autoplay
    // can only be recovered by a play() made inside the click itself.
    if (video.paused) {
      setIntent('play')
      play(video, openedRef)
    } else {
      setIntent('pause')
      video.pause()
    }
  }

  return (
    <figure ref={frameRef} className="group relative isolate">
      {/* The light the frame sits in. Static and filter-free: a radial
          gradient already has soft edges, and a `blur()` this large would
          re-raster under the hero's entrance transform. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-[6%] -top-[12%] -z-10 h-[70%] bg-[radial-gradient(50%_55%_at_50%_45%,rgba(139,92,246,0.14),transparent)]"
      />

      <div
        className="relative overflow-hidden rounded-xl border border-white/[0.10] bg-[#101116]"
        // The box is sized before a byte of video arrives, so the page below
        // never shifts when the poster lands.
        style={{ aspectRatio: `${FILM.width} / ${FILM.height}` }}
      >
        <video
          ref={videoRef}
          width={FILM.width}
          height={FILM.height}
          poster={FILM.poster}
          muted
          loop
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="absolute inset-0 h-full w-full object-cover"
        >
          {SOURCES.map((source) => (
            <source
              key={source.src}
              src={source.src}
              type={source.type}
              media={'media' in source ? source.media : undefined}
            />
          ))}
        </video>

        {/* Catches light along the top edge, the way the hero's own top rule
            does. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.18),transparent)]"
        />

        {/* WCAG 2.2.2: moving content that starts on its own and runs past
            five seconds needs a way to stop it. Bottom right, because the
            film's own captions sit bottom left. While the film plays the
            button only shows on hover or keyboard focus, because in the build
            scenes that corner is the terminal's footer. Touch screens have no
            hover, so they always see it, and a paused film always shows the
            way to resume it. */}
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pause the product film' : 'Play the product film'}
          className={`absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.10] bg-black/70 text-zinc-300 backdrop-blur-sm transition duration-200 hover:border-white/25 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 group-hover:opacity-100 md:bottom-4 md:right-4 md:h-9 md:w-9 ${
            playing ? 'opacity-0 [@media(hover:none)]:opacity-100' : 'opacity-100'
          }`}
        >
          {playing ? (
            <Pause aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Play aria-hidden className="h-3.5 w-3.5 translate-x-px" />
          )}
        </button>
      </div>

      {/* The film has no audio; everything it says is on screen. This is the
          same story for anyone who cannot see it. */}
      <figcaption className="sr-only">
        A 32-second film of the Backenly dashboard. A coding agent builds the
        backend for a project over MCP: tables, email sign-in, row-level
        security, a private storage bucket, and a function. It then asks to drop
        a table, and that destructive change is held for a human to approve. At
        3:12 AM, with nobody online, an index is dropped in production.
        Backenly’s self-healing loop detects it, adds the index back,
        re-checks it, and records an undoable change, while a riskier fix waits
        for review.
      </figcaption>
    </figure>
  )
}
