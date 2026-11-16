'use client'

/**
 * Provider marks for the Integrations page: the official mark, bare, at the
 * start of a row (decision 7: an identity mark for a provider, never a tile).
 *
 * Official marks (simple-icons, CC0), pasted verbatim from the package so a mark
 * is the real one and not an approximation. Verify with:
 *   curl -s https://cdn.jsdelivr.net/npm/simple-icons@13/icons/<slug>.svg
 *
 * Rendered with currentColor; the brand hex is applied to the glyph only, never
 * to surfaces or chrome. The hex is NOT always the one simple-icons publishes:
 * those are chosen for light backgrounds, and OpenAI, Resend and PostHog are all
 * black there, which is invisible on the console. A black-on-light mark renders
 * white here; PostHog and Anthropic use their own brand colour, which carries on
 * dark. A provider without an official mark here shows its category's icon in
 * the row's grey.
 */

import type { ComponentType, CSSProperties } from 'react'
import { BarChart2, Bell, Brain, Clapperboard, CreditCard, Mail, MessageSquare, Plug, type LucideIcon } from 'lucide-react'
import type { CatalogProvider } from './integration-catalog'

type LogoProps = { className?: string; style?: CSSProperties }

function StripeLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
    </svg>
  )
}

function OpenAILogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function AnthropicLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  )
}

function ResendLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M2.023 0v24h5.553v-8.434h2.998L15.326 24h6.65l-5.372-9.258a7.652 7.652 0 0 0 3.316-3.016c.709-1.21 1.062-2.57 1.062-4.08 0-1.462-.353-2.767-1.062-3.91-.709-1.165-1.692-2.079-2.95-2.742C15.737.331 14.355 0 12.823 0Zm5.553 4.87h4.219c.731 0 1.349.125 1.851.376.526.252.925.618 1.2 1.098.274.457.412.994.412 1.611S15.132 9.12 14.88 9.6c-.229.48-.572.856-1.03 1.13-.434.252-.948.38-1.542.38H7.576Z" />
    </svg>
  )
}

function PostHogLogo({ className, style }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden="true">
      <path d="M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z" />
    </svg>
  )
}

const LOGOS: Record<string, ComponentType<LogoProps>> = {
  stripe: StripeLogo,
  resend: ResendLogo,
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  posthog: PostHogLogo,
}

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  payments: CreditCard,
  email: Mail,
  sms: MessageSquare,
  push: Bell,
  ai: Brain,
  video: Clapperboard,
  analytics: BarChart2,
  other: Plug,
}

/**
 * The provider's mark, bare: 20px in a row, 24px beside a page title.
 * Decorative: the row or title says the provider's name.
 */
export function ProviderMark({
  provider,
  categoryId,
  size = 20,
  className = '',
}: {
  provider: Pick<CatalogProvider, 'id' | 'brandColor'>
  categoryId: string
  size?: 20 | 24
  className?: string
}) {
  const Logo = LOGOS[provider.id]
  const box = size === 24 ? 'h-[24px] w-[24px]' : 'h-[20px] w-[20px]'
  if (Logo) {
    return (
      <span aria-hidden className={`flex flex-shrink-0 items-center justify-center ${box} ${className}`}>
        <Logo
          className={`${size === 24 ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'} ${provider.brandColor ? '' : 'text-zinc-200'}`}
          style={provider.brandColor ? { color: provider.brandColor } : undefined}
        />
      </span>
    )
  }
  const Icon = CATEGORY_ICONS[categoryId] ?? Plug
  return (
    <span aria-hidden className={`flex flex-shrink-0 items-center justify-center ${box} ${className}`}>
      <Icon className={`${size === 24 ? 'h-[20px] w-[20px]' : 'h-[17px] w-[17px]'} text-zinc-400`} strokeWidth={1.75} />
    </span>
  )
}
