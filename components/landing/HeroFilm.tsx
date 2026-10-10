'use client'

/**
 * HeroFilm — the product film under the hero headline.
 *
 * Replaced the drawn, clickable dashboard (components/landing/HeroConsole,
 * deleted 2026-09-26, last present at f997755) on an explicit product
 * decision. Since v4 the film is the narrated launch film, 77 seconds of one
 * chain: an MCP key is pasted into Claude Code, the agent builds an online
 * store's backend through Backenly, it is published and takes orders, the
 * console's sections are shown one by one, and at 03:12 with nobody online
 * Backenly fixes what is safe and holds a riskier change for approval.
 *
 * THE STALENESS TRADE, taken knowingly. AutonomyFilm and the console were both
 * drawn rather than filmed because a recording of our own dashboard shipped on
 * this page once and was pulled when the product moved underneath it. That
 * risk is real here too. The contract that manages it:
 *
 *   - The film is versioned in its file names (`-v4`). A re-render ships under
 *     a NEW name (`-v5`), never over the old one: next.config.js serves
 *     /media/* as immutable, so a file replaced in place would stay stale in
 *     every browser that has already cached it for up to a year.
 *   - Re-render when anything the film shows changes shape: the shell's top
 *     bar and sidebar, the Connect page, the MCP tool names in the terminal,
 *     Deploy, the Database, Auth, Storage, Realtime and Monitoring pages, or
 *     the Overview's self-healing loop and review queue.
 *   - After a re-render, re-pick OPEN_AT and the poster frame (below).
 *
 * Files, all cut from the one 1920x1080 60fps master (H.264 + AAC, 69.6 MB):
 *
 *   hero-film-v4.mp4          desktop, H.264 High 5.1 CRF 28 (veryslow) + AAC
 *                             128k, 60fps, moov atom at the front, ~10.5 MB.
 *   hero-film-v4-1280.mp4     phones: H.264 High 4.0, 1280x720, 30fps, CRF 28
 *                             + AAC 96k, ~5.2 MB. Every phone decodes H.264
 *                             in hardware.
 *   hero-film-v4-poster.webp  the frame at OPEN_AT, ~49 KB
 *
 * The master's backdrop carries a fine animated grain (it keeps the violet
 * gradient from banding), and grain is what the bitrate pays for here. It is
 * kept rather than denoised: denoising would change the approved look and
 * bring the banding back. At CRF 28, text and the gradient look the same as
 * the master at 100%.
 *
 * No WebM this time, on measurement. v3 led with a VP9 cut because it was a
 * quarter lighter at the same picture. On this film it is not: VP9 two-pass
 * CRF 42 came out at 11.4 MB against the MP4's 10.5 MB, and was worse on
 * the camera moves (SSIM against the master, every frame: mean 0.990 with
 * 387 frames under 0.97, against the MP4's 0.994 with none). Every current
 * browser plays H.264 + AAC; one that cannot rests on the poster.
 *
 * Both cuts carry a keyframe at 0 and at OPEN_AT (the phone cut at its
 * nearest 30fps frame), so both places the film starts from decode without a
 * run-up.
 *
 * The `codecs` in each source's type are read from the files themselves (the
 * avcC box for H.264). Re-read them after a re-render: a browser trusts the
 * string, and one that claims a level the file exceeds skips a source it could
 * have played, or picks one it cannot.
 *
 * OPENS ON THE TITLE, NOT ON BLACK. The master fades up from black and fades
 * back to black (so it loops without a seam), and a poster taken from frame 0
 * would greet every visitor with an empty box. The poster is the settled
 * title card (wordmark, line, and the console in frame) just before the
 * camera pushes into Connect, and the first play seeks there, so there is no
 * jump from poster to picture: they are the same frame.
 *
 * SOUND IS OPT-IN. The film is narrated, and it always starts muted: browsers
 * refuse an unmuted autoplay anyway, and a page that talks before it is asked
 * to is the wrong first impression. The speaker button is the way in. Turning
 * sound on starts the film again from the top, because the narration is one
 * argument and arriving mid-sentence wastes it; muting and unmuting again
 * later carries on where it is. With sound on the film plays through once
 * rather than looping, so the narration never starts over by itself, and at
 * the end it goes back to the silent loop from the title card instead of
 * resting on the closing black frame.
 *
 * Reduced motion gets the title card as a still and never autoplays; either
 * button plays it on request. Playback also stops while the frame is off
 * screen, sound or not, and a visitor's own pause is never overridden by
 * scrolling back.
 *
 * Hydration: nothing here renders differently on the client's first pass.
 * There is deliberately no `autoPlay` attribute. It would start the film
 * before React could see the reduced-motion preference, and playback starts
 * in an effect anyway, where the poster and first picture are identical.
 */

import { useEffect, useRef, useState } from 'react'
import { useInView } from 'framer-motion'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

const FILM = {
  poster: '/media/hero-film-v4-poster.webp',
  width: 1920,
  height: 1080,
} as const

/**
 * In the order a browser should consider them; it takes the first one whose
 * `media` matches and whose `type` it can decode. Phones come first because
 * only the phone cut carries a condition. The phone cut is 30fps, but every
 * cut shares one timeline, so OPEN_AT holds for all of them.
 */
const SOURCES = [
  {
    src: '/media/hero-film-v4-1280.mp4',
    type: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    media: '(max-width: 767px)',
  },
  { src: '/media/hero-film-v4.mp4', type: 'video/mp4; codecs="avc1.640033, mp4a.40.2"' },
] as const satisfies readonly { src: string; type: string; media?: string }[]

/**
 * Seconds into the film where the title card has settled and before the
 * camera starts its push into Connect (4.4s to 5.08s in v4). Measured by
 * frame difference, not by eye. The poster is the frame at this time.
 */
const OPEN_AT = 4.95

/**
 * NO FRAME. The film is already staged: a violet backdrop with the console
 * window floating on it. Wrapping that in a border (or a bezel, or a lit top
 * edge) made a box inside a box inside a box. Instead the picture itself
 * fades out at its edges, shorter at the sides and top, longer at the bottom,
 * so the violet stage reads as light on the page, and when the camera is in
 * close the console runs straight into the page. Phones get shorter fades.
 * The mask is on the video alone; the controls stay crisp.
 */
const MASK =
  'linear-gradient(to right, transparent, #000 var(--fx), #000 calc(100% - var(--fx)), transparent), ' +
  'linear-gradient(to bottom, transparent, #000 var(--fx), #000 calc(100% - var(--fb)), transparent)'
const FEATHER = {
  maskImage: MASK,
  WebkitMaskImage: MASK,
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in',
} as const
/** The fade widths: a phone's picture is too small to give 9% of it away. */
const FEATHER_SIZE = '[--fx:4%] [--fb:12%] md:[--fx:9%] md:[--fb:26%]'

/**
 * `auto` follows the reduced-motion preference; `play` and `pause` are the
 * visitor's own choice and outrank it.
 */
type Intent = 'auto' | 'play' | 'pause'

/**
 * Starts (or resumes) the film, muted unless the visitor turned sound on. The
 * first call also seeks to OPEN_AT; `opened` remembers that it has, so a later
 * resume continues where the film was.
 */
function play(video: HTMLVideoElement, opened: { current: boolean }, sound: boolean) {
  // Autoplay policy reads the `muted` PROPERTY at play() time, and React has a
  // long history of owning that property separately from the server-rendered
  // attribute. Assert it here so the browser never sees an unmuted play the
  // visitor did not ask for.
  video.muted = !sound

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
  // Whether the next time sound comes on should start the film from the top:
  // true until it has, and true again once a narrated play-through ends.
  const fromTopRef = useRef(true)
  const reduced = useSettledReducedMotion()
  const inView = useInView(frameRef, { amount: 0.2 })
  const [intent, setIntent] = useState<Intent>('auto')
  const [sound, setSound] = useState(false)
  const [playing, setPlaying] = useState(false)

  const shouldPlay = inView && (intent === 'play' || (intent === 'auto' && !reduced))

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shouldPlay) play(video, openedRef, sound)
    else video.pause()
  }, [shouldPlay, sound])

  function toggle() {
    const video = videoRef.current
    if (!video) return

    // Drive the element directly as well as through state: a refused autoplay
    // can only be recovered by a play() made inside the click itself.
    if (video.paused) {
      setIntent('play')
      play(video, openedRef, sound)
    } else {
      setIntent('pause')
      video.pause()
    }
  }

  function toggleSound() {
    const video = videoRef.current
    if (!video) return

    if (sound) {
      video.muted = true
      setSound(false)
      return
    }

    if (fromTopRef.current) {
      fromTopRef.current = false
      // Claim the first-play seek too, so play() does not move a film that
      // has never played yet back to OPEN_AT.
      openedRef.current = true
      video.currentTime = 0
    }
    setSound(true)
    setIntent('play')
    // Unmuted playback is only allowed from inside the click.
    play(video, openedRef, true)
  }

  /** A narrated play-through has ended: back to the silent loop. */
  function finish() {
    const video = videoRef.current
    if (!video) return
    fromTopRef.current = true
    video.muted = true
    video.currentTime = OPEN_AT
    setSound(false)
    // The effect restarts the loop unless motion is reduced, in which case
    // the film rests on the title card it opened on.
    setIntent('auto')
  }

  return (
    <figure ref={frameRef} className="group relative isolate">
      {/* The light the film's violet stage spills onto the page, so its
          feathered edges fade into colour rather than straight to black.
          Static and filter-free: a radial gradient already has soft edges,
          and a `blur()` this large would re-raster under the hero's entrance
          transform. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-[8%] -inset-y-[10%] -z-10 bg-[radial-gradient(50%_50%_at_50%_42%,rgba(124,58,237,0.20),rgba(124,58,237,0.06)_60%,transparent)]"
      />

      <div
        className="relative"
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
          // With sound on the film plays through once; see SOUND IS OPT-IN.
          loop={!sound}
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={finish}
          className={`absolute inset-0 h-full w-full object-cover ${FEATHER_SIZE}`}
          style={FEATHER}
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

        {/* Bottom right, where a player's controls are looked for. The sound
            button is always shown, because a visitor cannot otherwise know
            the film has a voice. WCAG 2.2.2: moving content that starts on
            its own and runs past five seconds needs a way to stop it, so the
            pause button sits beside it; while the film plays that one only
            shows on hover or keyboard focus. Touch screens have no hover, so
            they always see it, and a paused film always shows the way to
            resume it. */}
        <div className="absolute bottom-2 right-2 flex gap-1.5 md:bottom-4 md:right-4 md:gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause the product film' : 'Play the product film'}
            className={`flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.10] bg-black/70 text-zinc-300 backdrop-blur-sm transition duration-200 hover:border-white/25 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 group-hover:opacity-100 md:h-9 md:w-9 ${
              playing ? 'opacity-0 [@media(hover:none)]:opacity-100' : 'opacity-100'
            }`}
          >
            {playing ? (
              <Pause aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <Play aria-hidden className="h-3.5 w-3.5 translate-x-px" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleSound}
            aria-label={sound ? 'Turn the film’s sound off' : 'Turn the film’s sound on'}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.10] bg-black/70 text-zinc-300 backdrop-blur-sm transition duration-200 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 md:h-9 md:w-9"
          >
            {sound ? (
              <Volume2 aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <VolumeX aria-hidden className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* The same story for anyone who cannot see or hear it: what is on
          screen, then the narration word for word. */}
      <figcaption className="sr-only">
        A 77-second narrated film of Backenly. On screen, an MCP key is created
        in Backenly and pasted into Claude Code, which builds the backend for
        UrbanCart, an online store, and publishes it. Orders arrive, and the
        console shows its Database, Auth, Storage, Realtime and Monitoring
        pages. At 3:12 AM a request slows down; Backenly adds a missing index
        on its own, while a foreign-key fix waits until a person approves it.
        The narration: Introducing Backenly. The autonomous backend platform,
        built for your coding agents. Copy one command. Paste it into your
        coding agent, and it’s connected. Ask for the backend you need. It
        builds through Backenly, and every change is verified. Publish it. And
        it’s live. Then the first orders come in. Each one lands in your
        database. With Auth, every customer signs in. Product photos load from
        Storage. Realtime streams every order. And Monitoring sees every
        request. And when something breaks while you’re away, Backenly finds
        it, fixes what’s safe, and proves the fix worked. Anything risky waits
        for you. Fixed, verified, and reversible. Your coding agent builds it.
        Backenly keeps it running. Try it for free.
      </figcaption>
    </figure>
  )
}
