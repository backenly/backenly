'use client'

import Link from 'next/link'
import { Logo } from '@/components/Logo'
import { Linkedin } from 'lucide-react'
import { ArrowUpRight } from 'lucide-react'

const LINKS = {
  product: [
    { label: 'Features', href: '/features' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Use Cases', href: '/use-cases' },
    { label: 'Comparisons', href: '/comparisons' },
  ],
  developers: [
    { label: 'Resources', href: '/resources' },
    { label: 'Documentation', href: '#', dim: true },
    { label: 'SDK Reference', href: '#', dim: true },
    { label: 'Status', href: '#', dim: true },
  ],
  company: [
    { label: 'Alternatives', href: '/alternatives' },
    { label: 'Contact', href: 'mailto:support@backenly.com' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Terms', href: '/terms' },
  ],
}

export function Footer() {
  return (
    <footer style={{
      background: '#0f0f14',
      borderTop: '1px solid rgba(255,255,255,0.055)',
      paddingInline: 'clamp(16px, 4vw, 64px)',
    }}>
      <div style={{ maxWidth: 1200, marginInline: 'auto' }}>

        {/* Top — logo, tagline, links */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: 48,
          paddingBlock: 64,
        }} className="footer-grid">

          {/* Brand */}
          <div>
            <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', marginBottom: 16 }}>
              <Logo />
              <span style={{ fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>backenly</span>
            </Link>
            <p style={{ fontSize: 13.5, color: '#5a5a72', lineHeight: 1.7, maxWidth: 260, marginBottom: 8 }}>
              AI builds the backend. You ship the product.
            </p>
            <p style={{ fontSize: 12, color: '#32323e', lineHeight: 1.6, maxWidth: 260, marginBottom: 24 }}>
              Database · REST APIs · Auth · Realtime · Storage. Generated from plain English, live in seconds.
            </p>

            {/* Socials */}
            <div style={{ display: 'flex', gap: 8 }}>
              <SocialBtn href="https://x.com/Backenly" label="X / Twitter">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </SocialBtn>
              <SocialBtn href="https://www.linkedin.com/company/117034579" label="LinkedIn">
                <Linkedin size={14} />
              </SocialBtn>
            </div>
          </div>

          {/* Link columns */}
          <FooterCol title="Product" links={LINKS.product} />
          <FooterCol title="Developers" links={LINKS.developers} />
          <FooterCol title="Company" links={LINKS.company} />
        </div>

        {/* Bottom bar */}
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.05)',
          paddingBlock: 24,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <p style={{ fontSize: 12.5, color: '#3a3a50' }}>
            © 2026 Backenly, Inc. · Built for builders who ship fast.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
            <span style={{ fontSize: 12, color: '#3a3a50' }}>All systems operational</span>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .footer-grid { grid-template-columns: 1fr 1fr !important; }
        }
        @media (max-width: 480px) {
          .footer-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </footer>
  )
}

function FooterCol({ title, links }: { title: string; links: { label: string; href: string; dim?: boolean }[] }) {
  return (
    <div>
      <h4 style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: '#eeeef5',
        marginBottom: 20,
      }}>{title}</h4>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {links.map(link => (
          <li key={link.label}>
            {link.href.startsWith('mailto') || link.href.startsWith('http') ? (
              <a href={link.href} style={{
                fontSize: 13.5, color: link.dim ? '#32323e' : '#5a5a72',
                textDecoration: 'none', transition: 'color 150ms',
                cursor: link.dim ? 'default' : 'pointer',
              }}
                onMouseEnter={e => { if (!link.dim) e.currentTarget.style.color = '#eeeef5' }}
                onMouseLeave={e => { if (!link.dim) e.currentTarget.style.color = '#5a5a72' }}
              >
                {link.label}
                {link.dim && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.5 }}>Soon</span>}
              </a>
            ) : (
              <Link href={link.href} style={{
                fontSize: 13.5, color: link.dim ? '#32323e' : '#5a5a72',
                textDecoration: 'none', transition: 'color 150ms',
                cursor: link.dim ? 'default' : 'pointer',
              }}
                onMouseEnter={e => { if (!link.dim) e.currentTarget.style.color = '#eeeef5' }}
                onMouseLeave={e => { if (!link.dim) e.currentTarget.style.color = '#5a5a72' }}
              >
                {link.label}
                {link.dim && <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.5 }}>Soon</span>}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SocialBtn({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a
      href={href} target="_blank" rel="noopener noreferrer" aria-label={label}
      style={{
        width: 34, height: 34, borderRadius: 9,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#5a5a72', textDecoration: 'none',
        transition: 'color 150ms, border-color 150ms, background 150ms',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = '#eeeef5'
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'
        e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = '#5a5a72'
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
      }}
    >
      {children}
    </a>
  )
}
