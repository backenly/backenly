'use client'

/**
 * The sign-in providers a project's end users can use, and their real marks.
 *
 * Every provider the end-user OAuth runtime serves (server/routes/oauth.ts) is
 * listed here, and the Sign-in methods pane renders a row for each: the page
 * once knew only Google and GitHub, so a Discord sign-in the agent had set up
 * worked for end users while the console had no row to see or turn off
 * (AUTH-F7, tests/unit/auth-console-visibility.spec.ts).
 */

import { Mail } from 'lucide-react'

export type ProviderId = 'google' | 'github' | 'discord' | 'facebook'

/** The runtime's whole set, in the order the console lists them. */
export const OAUTH_PROVIDER_IDS: readonly ProviderId[] = ['google', 'github', 'discord', 'facebook']

function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.16 7.16 0 0 1 0-4.58V6.62H1.29a12.04 12.04 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  )
}

function GitHubMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.82.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  )
}

function DiscordMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  )
}

function FacebookMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073Z" />
    </svg>
  )
}

export interface ProviderMeta {
  name: string
  Mark: typeof GoogleMark
  /** The mark's colour where the brand's own is too dark for the canvas. */
  markClass: string
  /** Where the founder creates the OAuth client. */
  console: string
  consoleName: string
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  google: {
    name: 'Google',
    Mark: GoogleMark,
    markClass: '',
    console: 'https://console.cloud.google.com/apis/credentials',
    consoleName: 'Google Cloud Console',
  },
  github: {
    name: 'GitHub',
    Mark: GitHubMark,
    markClass: 'text-zinc-200',
    console: 'https://github.com/settings/developers',
    consoleName: 'GitHub Developer Settings',
  },
  discord: {
    name: 'Discord',
    Mark: DiscordMark,
    markClass: 'text-zinc-200',
    console: 'https://discord.com/developers/applications',
    consoleName: 'Discord Developer Portal',
  },
  facebook: {
    name: 'Facebook',
    Mark: FacebookMark,
    markClass: 'text-zinc-200',
    console: 'https://developers.facebook.com/apps',
    consoleName: 'Meta for Developers',
  },
}

/** A provider id as the console names it: "Google", "Email". */
export function providerName(provider: string | null | undefined): string {
  const id = (provider || 'email').toLowerCase()
  const meta = (PROVIDER_META as Record<string, ProviderMeta | undefined>)[id]
  if (meta) return meta.name
  return id === 'email' ? 'Email' : id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * How a user's sign-in method reads: the provider's own mark and its name,
 * never the raw value ("google" in lower-case mono reads as an identifier).
 */
export function ProviderLabel({ provider, className = '' }: { provider: string | null | undefined; className?: string }) {
  const id = (provider || 'email').toLowerCase()
  const meta = (PROVIDER_META as Record<string, ProviderMeta | undefined>)[id]
  return (
    <span className={`inline-flex min-w-0 items-center gap-[6px] ${className}`}>
      {meta ? (
        <meta.Mark className={`h-[14px] w-[14px] flex-shrink-0 ${meta.markClass}`} />
      ) : (
        <Mail className="h-[14px] w-[14px] flex-shrink-0 text-zinc-400" strokeWidth={1.75} aria-hidden />
      )}
      <span className="truncate">{providerName(provider)}</span>
    </span>
  )
}
