'use client'

import { useState, useEffect } from 'react'
import { Menu, X, ChevronDown, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { Logo } from '@/components/Logo'
import { Linkedin } from 'lucide-react'

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [communityOpen, setCommunityOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <motion.header
      style={{
        position: 'fixed', top: 16, left: 16, right: 16, zIndex: 100,
        borderRadius: 16,
        background: scrolled ? 'rgba(14,14,22,0.94)' : 'rgba(18,18,28,0.78)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: scrolled ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(255,255,255,0.09)',
        boxShadow: scrolled
          ? '0 8px 40px rgba(0,0,0,0.4)'
          : '0 4px 20px rgba(0,0,0,0.25)',
        transition: 'background 300ms, border-color 300ms, box-shadow 300ms',
      }}
    >
      <div style={{ maxWidth: 1200, marginInline: 'auto', paddingInline: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>

          {/* Left: Logo + Nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Logo */}
            <Link href="/" style={{
              display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none',
              marginRight: 8,
            }}>
              <Logo />
              <span style={{ fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>backenly</span>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: '#7c3aed', boxShadow: '0 0 6px #7c3aed',
                marginLeft: -3, marginTop: 2, flexShrink: 0,
              }} />
            </Link>

            {/* Desktop Nav */}
            <nav style={{ display: 'flex', alignItems: 'center', gap: 2 }} className="desktop-nav">
              <NavLink href="/#product-demo">Product</NavLink>
              <NavLink href="/pricing">Pricing</NavLink>

              {/* Community dropdown */}
              <div
                style={{ position: 'relative' }}
                onMouseEnter={() => setCommunityOpen(true)}
                onMouseLeave={() => setCommunityOpen(false)}
              >
                <button style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '6px 12px', borderRadius: 8,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontSize: 14, fontWeight: 500, color: '#8b8b9e',
                  transition: 'color 150ms, background 150ms',
                }}
                  onMouseEnter={e => {
                    e.currentTarget.style.color = '#eeeef5'
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.color = '#8b8b9e'
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  Community
                  <ChevronDown size={13} style={{ transition: 'transform 200ms', transform: communityOpen ? 'rotate(180deg)' : 'none' }} />
                </button>

                <AnimatePresence>
                  {communityOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                      style={{
                        position: 'absolute', top: 'calc(100% + 8px)', left: 0,
                        width: 200, background: '#0d0d14',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 14, padding: 6,
                        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
                      }}
                    >
                      <DropdownLink href="https://x.com/Backenly" label="X (Twitter)" sub="@Backenly" icon={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                        </svg>
                      } />
                      <DropdownLink href="https://www.linkedin.com/company/117034579" label="LinkedIn" sub="Follow us" icon={<Linkedin size={14} />} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </nav>
          </div>

          {/* Right: CTA buttons */}
          <div className="desktop-nav" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a
              href="https://calendly.com/adarsh-c-jose/30min"
              target="_blank" rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', borderRadius: 8,
                fontSize: 14, fontWeight: 500, color: '#8b8b9e',
                textDecoration: 'none',
                transition: 'color 150ms',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#eeeef5')}
              onMouseLeave={e => (e.currentTarget.style.color = '#8b8b9e')}
            >
              Talk to founder
              <ArrowUpRight size={13} />
            </a>
            <Link
              href="/auth/login"
              style={{
                padding: '6px 14px', borderRadius: 8,
                fontSize: 14, fontWeight: 500, color: '#6b6b88',
                textDecoration: 'none', transition: 'color 150ms',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#eeeef5')}
              onMouseLeave={e => (e.currentTarget.style.color = '#6b6b88')}
            >
              Log in
            </Link>
            <Link
              href="/auth/signup"
              style={{
                padding: '8px 18px', borderRadius: 9,
                fontSize: 14, fontWeight: 600,
                background: '#ffffff', color: '#000',
                textDecoration: 'none',
                transition: 'opacity 150ms, transform 150ms',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.1) inset',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.opacity = '0.88'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.opacity = '1'
                e.currentTarget.style.transform = 'none'
              }}
            >
              Start free
            </Link>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(v => !v)}
            style={{
              display: 'none', padding: 8,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#8b8b9e', borderRadius: 8,
            }}
            className="mobile-menu-btn"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            style={{
              borderTop: '1px solid rgba(255,255,255,0.07)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <MobileLink href="/#product-demo" onClick={() => setMobileOpen(false)}>Product</MobileLink>
              <MobileLink href="/pricing" onClick={() => setMobileOpen(false)}>Pricing</MobileLink>
              <div style={{ paddingBlock: '8px 4px' }}>
                <div style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#32323e', marginBottom: 8, fontWeight: 600 }}>Community</div>
                <MobileLink href="https://x.com/Backenly" external onClick={() => setMobileOpen(false)}>X (Twitter)</MobileLink>
                <MobileLink href="https://www.linkedin.com/company/117034579" external onClick={() => setMobileOpen(false)}>LinkedIn</MobileLink>
              </div>
              <MobileLink href="https://calendly.com/adarsh-c-jose/30min" external onClick={() => setMobileOpen(false)}>
                Talk to founder
              </MobileLink>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Link href="/auth/login" onClick={() => setMobileOpen(false)} style={{
                  padding: '10px 16px', borderRadius: 10, textAlign: 'center',
                  fontSize: 14, fontWeight: 500, color: '#8b8b9e',
                  border: '1px solid rgba(255,255,255,0.08)',
                  textDecoration: 'none',
                }}>Log in</Link>
                <Link href="/auth/signup" onClick={() => setMobileOpen(false)} style={{
                  padding: '10px 16px', borderRadius: 10, textAlign: 'center',
                  fontSize: 14, fontWeight: 600, color: '#000', background: '#fff',
                  textDecoration: 'none',
                }}>Start free →</Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Responsive CSS */}
      <style>{`
        @media (max-width: 768px) {
          .desktop-nav { display: none !important; }
          .mobile-menu-btn { display: flex !important; }
        }
      `}</style>
    </motion.header>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      style={{
        padding: '6px 12px', borderRadius: 8,
        fontSize: 14, fontWeight: 500, color: '#8b8b9e',
        textDecoration: 'none', transition: 'color 150ms, background 150ms',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = '#eeeef5'
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = '#8b8b9e'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </a>
  )
}

function DropdownLink({ href, label, sub, icon }: { href: string; label: string; sub: string; icon: React.ReactNode }) {
  return (
    <a
      href={href} target="_blank" rel="noopener noreferrer"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 10,
        textDecoration: 'none', color: '#8b8b9e',
        transition: 'background 150ms, color 150ms',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
        e.currentTarget.style.color = '#eeeef5'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = '#8b8b9e'
      }}
    >
      <span style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {icon}
      </span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'inherit', lineHeight: 1.2 }}>{label}</div>
        <div style={{ fontSize: 11, color: '#404058', marginTop: 1 }}>{sub}</div>
      </div>
      <ArrowUpRight size={12} style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.4 }} />
    </a>
  )
}

function MobileLink({ href, children, external, onClick }: { href: string; children: React.ReactNode; external?: boolean; onClick: () => void }) {
  const props = external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  return (
    <a
      href={href} {...props} onClick={onClick}
      style={{
        padding: '9px 12px', borderRadius: 9,
        fontSize: 14, fontWeight: 500, color: '#8b8b9e',
        textDecoration: 'none', display: 'block',
        transition: 'color 150ms, background 150ms',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = '#eeeef5'
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = '#8b8b9e'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </a>
  )
}
