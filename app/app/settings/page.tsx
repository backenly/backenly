'use client'

/**
 * Account Settings (/app/settings) — IA restructure §5.6.
 *
 * Rebuilt to live INSIDE the org shell (§5) and speak the locked flat kit (§11):
 * #16171d panels, hairline borders, mono numerals, violet only for action/
 * attention — no ambient glows, no gradient cover cards, no "Back" button. The
 * org sidebar is the only navigation; sub-sections are in-page tabs.
 *
 * Billing was promoted to its own org page (§5.4) — any legacy ?tab=billing
 * deep link redirects there. Every auth handler (profile, 2FA, password,
 * support/feature, delete) is preserved verbatim from the pre-restructure page.
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  LogOut, Mail, Lock, Trash2, HelpCircle, Key, Check, X,
  User, Shield, AlertTriangle, Sparkles, Smartphone, MessageSquare,
  Activity, Calendar, FolderKanban, Loader2, Copy, ShieldCheck, ShieldAlert,
  Send, ArrowUpRight, CheckCircle2,
} from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  SectionTitle, KitCard, KitCardHeader, KitCardBody, KitButton,
  KitField, KitInput, KitNote, KitBadge, KitTabs, KitTab,
} from '@/components/inspector/kit'
import { GlobalLoading } from '@/components/ui/GlobalLoading'

type Section = 'profile' | 'security' | 'support' | 'danger'

interface UserProfile {
  id: string
  email: string
  name?: string | null
  provider?: string
  emailVerified?: boolean
  twoFactorEnabled?: boolean
  createdAt?: string
  lastLogin?: string | null
  tier?: string
  projectsCount?: number
}

function providerLabel(p?: string): string {
  if (!p || p === 'email') return 'Email & Password'
  return p.charAt(0).toUpperCase() + p.slice(1)
}

function fmtDate(d?: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtRelative(d?: string | null): string {
  if (!d) return 'Never'
  const date = new Date(d)
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return fmtDate(d)
}

function planLabelFor(tier?: string): string {
  if (tier === 'pro') return 'Pro'
  if (tier === 'enterprise' || tier === 'scale') return 'Enterprise'
  if (tier === 'starter' || tier === 'builder') return 'Pro'
  return 'Free'
}

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeSection, setActiveSection] = useState<Section>('profile')
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null)

  // Profile
  const [editingName, setEditingName] = useState(false)
  const [newName, setNewName] = useState('')
  const [savingName, setSavingName] = useState(false)

  // Delete account
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)

  // Password
  const [resetLoading, setResetLoading] = useState(false)

  // 2FA
  const [twoFAModal, setTwoFAModal] = useState<null | 'enroll' | 'disable'>(null)
  const [twoFASetup, setTwoFASetup] = useState<{ qrCodeUrl: string; secret: string } | null>(null)
  const [twoFACode, setTwoFACode] = useState('')
  const [twoFALoading, setTwoFALoading] = useState(false)
  const [twoFABackupCodes, setTwoFABackupCodes] = useState<string[] | null>(null)

  const showToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    setToast({ kind, msg })
    setTimeout(() => setToast(null), 3500)
  }

  const refreshUser = async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' })
      if (!response.ok) { router.push('/login'); return }
      const data = await response.json()
      const u = data.user ?? data
      setUser(u)
      setNewName(u?.name || '')
    } catch {
      router.push('/login')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Honor deep links like /app/settings?tab=security. Billing moved to its
    // own org page (§5.4) — send legacy ?tab=billing there.
    const tab = new URLSearchParams(window.location.search).get('tab')
    if (tab === 'billing') { router.replace('/app/billing'); return }
    if (tab && ['profile', 'security', 'support', 'danger'].includes(tab)) {
      setActiveSection(tab as Section)
    }
    refreshUser()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSaveName = async () => {
    setSavingName(true)
    try {
      const response = await fetch('/api/auth/update-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newName }),
      })
      if (response.ok) {
        setUser(prev => prev ? { ...prev, name: newName } : null)
        setEditingName(false)
        showToast('Display name updated')
      } else {
        showToast('Failed to update name', 'error')
      }
    } catch {
      showToast('Failed to update name', 'error')
    } finally {
      setSavingName(false)
    }
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return
    setDeletingAccount(true)
    try {
      const response = await fetch('/api/auth/delete-account', { method: 'DELETE', credentials: 'include' })
      if (response.ok) router.push('/login')
      else showToast('Failed to delete account', 'error')
    } catch {
      showToast('Failed to delete account', 'error')
    } finally {
      setDeletingAccount(false)
      setShowDeleteModal(false)
      setDeleteConfirmText('')
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      router.push('/login')
    } catch { /* noop */ }
  }

  const handlePasswordReset = async () => {
    if (!user?.email) return
    setResetLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      })
      showToast(res.ok ? 'Password reset link sent to your email' : 'Could not send reset link. Try again', res.ok ? 'success' : 'error')
    } catch {
      showToast('Could not send reset link. Try again', 'error')
    } finally {
      setResetLoading(false)
    }
  }

  const handle2FABegin = async () => {
    setTwoFALoading(true)
    setTwoFACode('')
    setTwoFABackupCodes(null)
    try {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST', credentials: 'include' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || 'Failed to start 2FA setup', 'error')
        return
      }
      const data = await res.json()
      setTwoFASetup({ qrCodeUrl: data.qrCodeUrl, secret: data.secret })
      setTwoFAModal('enroll')
    } catch {
      showToast('Failed to start 2FA setup', 'error')
    } finally {
      setTwoFALoading(false)
    }
  }

  const handle2FAVerify = async () => {
    if (!/^\d{6}$/.test(twoFACode)) { showToast('Enter the 6-digit code from your app', 'error'); return }
    setTwoFALoading(true)
    try {
      const res = await fetch('/api/auth/2fa/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: twoFACode }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Invalid code', 'error'); return }
      setTwoFABackupCodes(data.backupCodes || [])
      await refreshUser()
      showToast('Two-factor authentication enabled')
    } catch {
      showToast('Verification failed', 'error')
    } finally {
      setTwoFALoading(false)
    }
  }

  const handle2FADisable = async () => {
    if (twoFACode.length < 6) { showToast('Enter a TOTP or backup code', 'error'); return }
    setTwoFALoading(true)
    try {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: twoFACode }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Invalid code', 'error'); return }
      await refreshUser()
      setTwoFAModal(null)
      setTwoFACode('')
      showToast('Two-factor authentication disabled')
    } catch {
      showToast('Failed to disable 2FA', 'error')
    } finally {
      setTwoFALoading(false)
    }
  }

  const closeTwoFAModal = () => {
    setTwoFAModal(null)
    setTwoFASetup(null)
    setTwoFACode('')
    setTwoFABackupCodes(null)
  }

  if (loading) return <GlobalLoading message="Loading your settings..." />

  const initials = user?.name
    ? user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() ?? 'U'

  const TABS: { id: Section; label: string; icon: typeof User }[] = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'support', label: 'Support', icon: HelpCircle },
    { id: 'danger', label: 'Danger zone', icon: AlertTriangle },
  ]

  return (
    <OrgShell>
      {/* Toast */}
      {toast && (
        <div className="fixed top-16 right-6 z-50">
          <div className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 bg-[#1c1d23] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] ${
            toast.kind === 'success' ? 'border-emerald-500/25' : 'border-rose-500/25'
          }`}>
            {toast.kind === 'success'
              ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              : <AlertTriangle className="h-4 w-4 text-rose-400" />}
            <p className="text-[12.5px] font-medium text-zinc-100">{toast.msg}</p>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[1000px] px-6 py-8 lg:px-10">
        <SectionTitle
          title="Settings"
          description="Manage your profile, security and account."
          actions={
            <KitButton variant="secondary" size="sm" icon={LogOut} onClick={handleLogout}>
              Sign out
            </KitButton>
          }
        />

        <KitTabs className="mb-5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <KitTab key={id} active={activeSection === id} onClick={() => setActiveSection(id)}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </KitTab>
          ))}
        </KitTabs>

        {activeSection === 'profile' && (
          <ProfileSection
            user={user}
            initials={initials}
            planLabel={planLabelFor(user?.tier)}
            editingName={editingName}
            setEditingName={setEditingName}
            newName={newName}
            setNewName={setNewName}
            savingName={savingName}
            onSaveName={handleSaveName}
          />
        )}

        {activeSection === 'security' && (
          <SecuritySection
            user={user}
            onPasswordReset={handlePasswordReset}
            resetLoading={resetLoading}
            on2FAEnroll={handle2FABegin}
            on2FADisableOpen={() => { setTwoFAModal('disable'); setTwoFACode('') }}
            twoFALoading={twoFALoading}
            onLogout={handleLogout}
          />
        )}

        {activeSection === 'support' && <SupportSection userEmail={user?.email} />}

        {activeSection === 'danger' && <DangerSection onOpenDelete={() => setShowDeleteModal(true)} />}
      </div>

      {/* Delete account modal */}
      {showDeleteModal && (
        <ModalShell onClose={() => !deletingAccount && setShowDeleteModal(false)} accent="danger">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              <h3 className="text-base font-semibold text-white">Delete account</h3>
            </div>
            <button onClick={() => setShowDeleteModal(false)} className="rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-5">
            <div className="rounded-lg border border-rose-500/15 bg-rose-500/[0.04] p-4">
              <p className="text-[13px] font-semibold text-rose-300">This is permanent and cannot be undone.</p>
              <ul className="mt-3 space-y-1.5">
                {['Your account and profile', 'All projects and databases', 'All files and configurations', 'All billing information'].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-[12.5px] text-zinc-400">
                    <span className="h-1 w-1 rounded-full bg-rose-400/50" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-4">
              <KitField label={<span>Type <span className="font-mono text-rose-300">DELETE</span> to confirm</span>}>
                <KitInput
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="DELETE"
                  autoFocus
                  className="font-mono"
                />
              </KitField>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <KitButton variant="secondary" onClick={() => { setShowDeleteModal(false); setDeleteConfirmText('') }} disabled={deletingAccount}>
                Cancel
              </KitButton>
              <KitButton
                variant="danger"
                icon={deletingAccount ? undefined : Trash2}
                onClick={handleDeleteAccount}
                disabled={deletingAccount || deleteConfirmText !== 'DELETE'}
              >
                {deletingAccount ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting…</> : 'Delete account'}
              </KitButton>
            </div>
          </div>
        </ModalShell>
      )}

      {/* 2FA modal */}
      {twoFAModal && (
        <ModalShell onClose={() => !twoFALoading && !twoFABackupCodes && closeTwoFAModal()}>
          {twoFAModal === 'enroll' && !twoFABackupCodes && twoFASetup && (
            <>
              <ModalHeader icon={Smartphone} title="Set up authenticator" subtitle="Step 1 of 2" onClose={closeTwoFAModal} />
              <div className="p-5">
                <p className="text-[12.5px] leading-5 text-zinc-400">
                  Scan this QR code with Google Authenticator, 1Password, Authy or any TOTP app.
                </p>
                <div className="mx-auto mt-4 flex w-fit items-center justify-center rounded-lg bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={twoFASetup.qrCodeUrl} alt="2FA QR code" className="h-44 w-44" />
                </div>
                <div className="mt-4">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Or enter manually</p>
                  <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-[#0f1015] px-3 py-2">
                    <code className="flex-1 break-all font-mono text-[12px] text-violet-200/90">{twoFASetup.secret}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(twoFASetup.secret); showToast('Secret copied') }}
                      className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-4">
                  <KitField label="Enter the 6-digit code">
                    <input
                      inputMode="numeric"
                      maxLength={6}
                      value={twoFACode}
                      onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      autoFocus
                      className="w-full rounded-lg border border-white/[0.07] bg-[#0f1015] px-4 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
                    />
                  </KitField>
                </div>
                <div className="mt-5 flex items-center justify-end gap-2">
                  <KitButton variant="secondary" onClick={closeTwoFAModal} disabled={twoFALoading}>Cancel</KitButton>
                  <KitButton variant="primary" onClick={handle2FAVerify} disabled={twoFALoading || twoFACode.length !== 6} icon={twoFALoading ? undefined : Check}>
                    {twoFALoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying…</> : 'Enable 2FA'}
                  </KitButton>
                </div>
              </div>
            </>
          )}

          {twoFAModal === 'enroll' && twoFABackupCodes && (
            <>
              <ModalHeader icon={ShieldCheck} title="Save your backup codes" subtitle="Each can be used once" onClose={closeTwoFAModal} />
              <div className="p-5">
                <KitNote icon={AlertTriangle} tone="warn">
                  Store these somewhere safe. We won't show them again.
                </KitNote>
                <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-white/[0.07] bg-[#0f1015] p-4">
                  {twoFABackupCodes.map((code, i) => (
                    <div key={i} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-center font-mono text-[12.5px] text-violet-100/90">
                      {code}
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex items-center justify-end gap-2">
                  <KitButton variant="secondary" icon={Copy} onClick={() => { navigator.clipboard.writeText(twoFABackupCodes.join('\n')); showToast('Backup codes copied') }}>
                    Copy all
                  </KitButton>
                  <KitButton variant="primary" onClick={closeTwoFAModal}>Done</KitButton>
                </div>
              </div>
            </>
          )}

          {twoFAModal === 'disable' && (
            <>
              <ModalHeader icon={ShieldAlert} title="Disable 2FA" subtitle="Verify it's really you" onClose={closeTwoFAModal} />
              <div className="p-5">
                <p className="text-[12.5px] leading-5 text-zinc-400">
                  Enter a code from your authenticator app, or one of your backup codes.
                </p>
                <div className="mt-4">
                  <KitInput
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value)}
                    placeholder="6-digit code or XXXX-XXXX"
                    autoFocus
                    className="text-center font-mono"
                  />
                </div>
                <div className="mt-5 flex items-center justify-end gap-2">
                  <KitButton variant="secondary" onClick={closeTwoFAModal} disabled={twoFALoading}>Cancel</KitButton>
                  <KitButton variant="danger" onClick={handle2FADisable} disabled={twoFALoading || twoFACode.length < 6} icon={twoFALoading ? undefined : ShieldAlert}>
                    {twoFALoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Disabling…</> : 'Disable 2FA'}
                  </KitButton>
                </div>
              </div>
            </>
          )}
        </ModalShell>
      )}
    </OrgShell>
  )
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function ProfileSection({
  user, initials, planLabel, editingName, setEditingName, newName, setNewName, savingName, onSaveName,
}: {
  user: UserProfile | null
  initials: string
  planLabel: string
  editingName: boolean
  setEditingName: (v: boolean) => void
  newName: string
  setNewName: (v: string) => void
  savingName: boolean
  onSaveName: () => void
}) {
  return (
    <div className="space-y-4">
      {/* Identity */}
      <KitCard>
        <div className="flex flex-wrap items-center gap-4 px-5 py-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-lg font-semibold text-zinc-100">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight text-white">{user?.name || 'Unnamed user'}</h2>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">{user?.email}</p>
          </div>
          <div className="flex items-center gap-2">
            {user?.emailVerified && <KitBadge tone="operational">Verified</KitBadge>}
            <KitBadge tone="beta" icon={Sparkles}>{planLabel}</KitBadge>
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-white/[0.06] divide-x divide-white/[0.04] sm:grid-cols-4">
          <Stat icon={Calendar} label="Member since" value={fmtDate(user?.createdAt)} />
          <Stat icon={FolderKanban} label="Projects" value={String(user?.projectsCount ?? 0)} />
          <Stat icon={Activity} label="Last login" value={fmtRelative(user?.lastLogin)} />
          <Stat icon={Key} label="Sign-in" value={providerLabel(user?.provider)} />
        </div>
      </KitCard>

      {/* Personal info */}
      <KitCard>
        <KitCardHeader title="Personal information" description="How you appear across Backenly" />
        <KitCardBody className="space-y-4">
          <KitField label="Email address" hint="Your email can't be changed. Contact support if needed.">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                value={user?.email || ''}
                disabled
                className="h-8 w-full cursor-not-allowed rounded-lg border border-white/[0.07] bg-white/[0.02] pl-9 pr-3 text-[12.5px] text-zinc-400"
              />
            </div>
          </KitField>

          <KitField label="Display name" hint="Visible on your profile and in collaborator lists.">
            {editingName ? (
              <div className="flex items-center gap-2">
                <KitInput value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Enter your name" autoFocus />
                <KitButton variant="primary" onClick={onSaveName} disabled={savingName} icon={savingName ? undefined : Check}>
                  {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                </KitButton>
                <KitButton variant="ghost" onClick={() => { setEditingName(false); setNewName(user?.name || '') }} icon={X}>{''}</KitButton>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  value={user?.name || 'Not set'}
                  disabled
                  className={`h-8 flex-1 cursor-not-allowed rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 text-[12.5px] ${user?.name ? 'text-zinc-200' : 'italic text-zinc-600'}`}
                />
                <KitButton variant="secondary" onClick={() => setEditingName(true)}>Edit</KitButton>
              </div>
            )}
          </KitField>
        </KitCardBody>
      </KitCard>
    </div>
  )
}

// ─── Security ─────────────────────────────────────────────────────────────────

function SecuritySection({
  user, onPasswordReset, resetLoading, on2FAEnroll, on2FADisableOpen, twoFALoading, onLogout,
}: {
  user: UserProfile | null
  onPasswordReset: () => void
  resetLoading: boolean
  on2FAEnroll: () => void
  on2FADisableOpen: () => void
  twoFALoading: boolean
  onLogout: () => void
}) {
  const isEmailUser = user?.provider === 'email' || !user?.provider
  const twoFAOn = !!user?.twoFactorEnabled

  return (
    <div className="space-y-4">
      {/* Sign-in method */}
      <KitCard>
        <KitCardHeader title="Sign-in method" description="How you authenticate with Backenly" />
        <KitCardBody>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
              {user?.provider === 'google' ? <GoogleIcon /> : user?.provider === 'github' ? <GitHubIcon /> : <Mail className="h-4 w-4 text-violet-300" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-zinc-100">{providerLabel(user?.provider)}</p>
              <p className="mt-0.5 text-[11.5px] text-zinc-500">
                {isEmailUser ? 'Signed in with email and password' : `Managed by ${providerLabel(user?.provider)}`}
              </p>
            </div>
            <KitBadge tone="operational">Active</KitBadge>
          </div>
        </KitCardBody>
      </KitCard>

      {/* 2FA */}
      <KitCard>
        <KitCardHeader
          title="Two-factor authentication"
          description={twoFAOn ? 'Your account is protected with 2FA' : 'Add an extra layer of security'}
          actions={
            twoFAOn
              ? <KitButton variant="secondary" size="sm" onClick={on2FADisableOpen} disabled={twoFALoading}>Disable</KitButton>
              : <KitButton variant="primary" size="sm" icon={Sparkles} onClick={on2FAEnroll} disabled={twoFALoading}>Enable 2FA</KitButton>
          }
        />
        <KitCardBody>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
              <Smartphone className={`h-4 w-4 ${twoFAOn ? 'text-emerald-400' : 'text-zinc-500'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-zinc-100">Authenticator app</p>
              <p className="mt-0.5 text-[11.5px] text-zinc-500">
                {twoFAOn ? 'A code is required from your authenticator on every sign-in.' : 'Use Google Authenticator, 1Password, Authy or similar.'}
              </p>
            </div>
            {twoFAOn && <KitBadge tone="operational">On</KitBadge>}
          </div>
        </KitCardBody>
      </KitCard>

      {/* Password */}
      <KitCard>
        <KitCardHeader title="Password" description="Reset your password via email" />
        <KitCardBody>
          {isEmailUser ? (
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
                <Lock className="h-4 w-4 text-zinc-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-zinc-100">Send password reset link</p>
                <p className="mt-0.5 text-[11.5px] text-zinc-500">We'll email a secure link to {user?.email}.</p>
              </div>
              <KitButton variant="secondary" size="sm" icon={resetLoading ? undefined : Mail} onClick={onPasswordReset} disabled={resetLoading}>
                {resetLoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</> : 'Send link'}
              </KitButton>
            </div>
          ) : (
            <p className="text-[12.5px] text-zinc-400">
              Your password is managed by <span className="font-medium text-zinc-200">{providerLabel(user?.provider)}</span>. Update it in your provider's account settings.
            </p>
          )}
        </KitCardBody>
      </KitCard>

      {/* Session */}
      <KitCard>
        <KitCardHeader title="Active session" description="Sign out from this device" />
        <KitCardBody>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-zinc-100">This browser</p>
              <p className="mt-0.5 text-[11.5px] text-zinc-500">Last signed in {fmtRelative(user?.lastLogin)}.</p>
            </div>
            <KitButton variant="secondary" size="sm" icon={LogOut} onClick={onLogout}>Sign out</KitButton>
          </div>
        </KitCardBody>
      </KitCard>
    </div>
  )
}

// ─── Support ──────────────────────────────────────────────────────────────────

type FormKind = 'support' | 'feature'
const PRIMARY_MAX = 160
const SECONDARY_MAX = 5000
const SECONDARY_MIN = 10

function SupportSection({ userEmail }: { userEmail?: string }) {
  const [activeForm, setActiveForm] = useState<FormKind | null>(null)

  const configs = {
    support: {
      kind: 'support' as const,
      icon: MessageSquare,
      title: 'Contact support',
      cardDesc: 'Email our team. Typical reply in under a few hours.',
      formDesc: 'Describe what went wrong. The more detail, the faster we can help.',
      primaryLabel: 'Subject',
      primaryHint: 'A short summary of the issue',
      primaryPlaceholder: "e.g. Can't deploy my project",
      secondaryLabel: 'Message',
      secondaryHint: 'Steps to reproduce, error messages, expected behavior',
      secondaryPlaceholder: 'What were you trying to do? What happened instead? Include any error messages.',
      successTitle: 'Message sent',
      successMsg: "We'll get back to you over email shortly.",
      submitLabel: 'Send message',
    },
    feature: {
      kind: 'feature' as const,
      icon: Sparkles,
      title: 'Request a feature',
      cardDesc: 'Tell us what you want to see in Backenly next.',
      formDesc: 'Help us understand the problem you want to solve, not just the solution.',
      primaryLabel: 'Feature title',
      primaryHint: 'One line: what should we build?',
      primaryPlaceholder: 'e.g. Add MongoDB support',
      secondaryLabel: 'Why you need it',
      secondaryHint: 'The use case, your current workaround, and how it would change your workflow',
      secondaryPlaceholder: 'What problem does this solve? How are you working around it today?',
      successTitle: 'Request received',
      successMsg: "This goes straight to the founder's roadmap.",
      submitLabel: 'Submit request',
    },
  }
  const active = activeForm ? configs[activeForm] : null

  return (
    <div className="space-y-4">
      <KitCard>
        <KitCardHeader title="Get help" description="Support and feature requests" />
        <KitCardBody>
          {active ? (
            <InlineForm {...active} userEmail={userEmail} onBack={() => setActiveForm(null)} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[configs.support, configs.feature].map((c) => {
                const Icon = c.icon
                return (
                  <button
                    key={c.kind}
                    onClick={() => setActiveForm(c.kind)}
                    className="group flex items-start gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-4 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.04]"
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
                      <Icon className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-violet-300" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <p className="text-[13px] font-medium text-zinc-100">{c.title}</p>
                        <ArrowUpRight className="h-3.5 w-3.5 text-zinc-600 transition-colors group-hover:text-zinc-300" />
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">{c.cardDesc}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </KitCardBody>
      </KitCard>

      <KitNote icon={Mail} tone="info" title="Prefer email?">
        Reach our team directly at{' '}
        <a href="mailto:support@backenly.com" className="text-violet-300 underline underline-offset-2 hover:text-violet-200">support@backenly.com</a>
. Most replies go out within a few hours.
      </KitNote>
    </div>
  )
}

function InlineForm({
  kind, icon: Icon, title, formDesc,
  primaryLabel, primaryHint, primaryPlaceholder,
  secondaryLabel, secondaryHint, secondaryPlaceholder,
  successTitle, successMsg, submitLabel, userEmail, onBack,
}: {
  kind: FormKind
  icon: React.ElementType
  title: string
  formDesc: string
  primaryLabel: string
  primaryHint: string
  primaryPlaceholder: string
  secondaryLabel: string
  secondaryHint: string
  secondaryPlaceholder: string
  successTitle: string
  successMsg: string
  submitLabel: string
  userEmail?: string
  onBack: () => void
}) {
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const primaryValid = primary.trim().length > 0 && primary.trim().length <= PRIMARY_MAX
  const secondaryValid = secondary.trim().length >= SECONDARY_MIN && secondary.trim().length <= SECONDARY_MAX
  const canSubmit = !busy && primaryValid && secondaryValid

  const submit = async () => {
    setError(null)
    if (!primaryValid) { setError(`${primaryLabel} is required (max ${PRIMARY_MAX} characters).`); return }
    if (!secondaryValid) { setError(`${secondaryLabel} must be at least ${SECONDARY_MIN} characters.`); return }
    setBusy(true)
    try {
      const url = kind === 'support' ? '/api/support/contact' : '/api/feature-request'
      const payload = kind === 'support'
        ? { subject: primary.trim(), message: secondary.trim() }
        : { title: primary.trim(), body: secondary.trim() }
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `Submission failed (${r.status})`)
      }
      setSent(true); setPrimary(''); setSecondary('')
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
          <Check className="h-5 w-5 text-emerald-400" strokeWidth={3} />
        </div>
        <p className="mt-4 text-[14px] font-semibold text-white">{successTitle}</p>
        <p className="mt-1.5 max-w-[320px] text-[12.5px] leading-relaxed text-zinc-500">{successMsg}</p>
        {userEmail && <p className="mt-3 text-[11.5px] text-zinc-600">Reply will be sent to <span className="text-zinc-400">{userEmail}</span></p>}
        <div className="mt-5 flex items-center gap-2">
          <KitButton variant="secondary" size="sm" onClick={() => setSent(false)}>Submit another</KitButton>
          <KitButton variant="ghost" size="sm" onClick={onBack}>Done</KitButton>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04]">
          <Icon className="h-4 w-4 text-violet-300" />
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-zinc-100">{title}</p>
          <p className="truncate text-[11.5px] text-zinc-500">{formDesc}</p>
        </div>
      </div>

      <div className="space-y-4">
        {userEmail && (
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <Mail className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
            <span className="text-[11.5px] text-zinc-500">Sending as</span>
            <span className="truncate text-[11.5px] font-medium text-zinc-300">{userEmail}</span>
          </div>
        )}

        <KitField label={<span className="flex items-center justify-between"><span>{primaryLabel}</span><span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{primary.length}/{PRIMARY_MAX}</span></span>} hint={primaryHint}>
          <KitInput value={primary} onChange={(e) => setPrimary(e.target.value)} maxLength={PRIMARY_MAX} placeholder={primaryPlaceholder} disabled={busy} />
        </KitField>

        <KitField label={<span className="flex items-center justify-between"><span>{secondaryLabel}</span><span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{secondary.length}/{SECONDARY_MAX}</span></span>} hint={secondaryHint}>
          <textarea
            value={secondary}
            onChange={(e) => setSecondary(e.target.value)}
            maxLength={SECONDARY_MAX}
            placeholder={secondaryPlaceholder}
            disabled={busy}
            rows={6}
            className="w-full resize-none rounded-lg border border-white/[0.07] bg-[#0f1015] px-3 py-2.5 text-[12.5px] leading-relaxed text-zinc-50 outline-none transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15"
          />
        </KitField>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
            <p className="text-[12px] leading-snug text-rose-300">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <KitButton variant="ghost" onClick={onBack} disabled={busy}>Cancel</KitButton>
          <KitButton variant="primary" onClick={submit} disabled={!canSubmit} icon={busy ? undefined : Send}>
            {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</> : submitLabel}
          </KitButton>
        </div>
      </div>
    </div>
  )
}

// ─── Danger ───────────────────────────────────────────────────────────────────

function DangerSection({ onOpenDelete }: { onOpenDelete: () => void }) {
  return (
    <KitCard className="border-rose-500/20">
      <div className="flex items-center gap-2.5 border-b border-rose-500/[0.12] bg-rose-500/[0.03] px-5 py-3.5">
        <AlertTriangle className="h-4 w-4 text-rose-400" />
        <div>
          <h2 className="text-[13px] font-semibold text-white">Danger zone</h2>
          <p className="text-[11.5px] text-zinc-500">Irreversible and destructive actions.</p>
        </div>
      </div>
      <KitCardBody>
        <div className="rounded-lg border border-rose-500/15 bg-rose-500/[0.03] p-4">
          <p className="text-[13px] font-semibold text-white">Delete account permanently</p>
          <p className="mt-1 text-[12px] text-zinc-500">Removes your account, all projects and data, files, and memberships forever.</p>
          <div className="mt-4">
            <KitButton variant="danger" icon={Trash2} onClick={onOpenDelete}>Delete my account</KitButton>
          </div>
        </div>
      </KitCardBody>
    </KitCard>
  )
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-zinc-600" />
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{label}</p>
      </div>
      <p className="mt-1.5 truncate text-[13px] font-medium text-zinc-200">{value}</p>
    </div>
  )
}

function ModalShell({ children, onClose, accent = 'default' }: { children: React.ReactNode; onClose: () => void; accent?: 'default' | 'danger' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className={`relative w-full max-w-md overflow-hidden rounded-xl border bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] ${accent === 'danger' ? 'border-rose-500/20' : 'border-white/[0.07]'}`}>
        {children}
      </div>
    </div>
  )
}

function ModalHeader({ icon: Icon, title, subtitle, onClose }: { icon: React.ElementType; title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
      <div className="flex items-center gap-2.5">
        <Icon className="h-4 w-4 text-violet-300" />
        <div>
          <h3 className="text-base font-semibold leading-none text-white">{title}</h3>
          {subtitle && <p className="mt-1 text-[11.5px] text-zinc-500">{subtitle}</p>}
        </div>
      </div>
      <button onClick={onClose} className="rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white" aria-label="Close">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// Provider icons (inline SVG to avoid extra deps)
function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 1 1-3.4-12.9l5.7-5.7A20 20 0 1 0 44 24c0-1.2-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8A12 12 0 0 1 24 12c3 0 5.8 1.1 8 3l5.7-5.7A20 20 0 0 0 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44a20 20 0 0 0 13.4-5.2l-6.2-5.2A12 12 0 0 1 12.7 28l-6.6 5.1A20 20 0 0 0 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.2-.1-2.4-.4-3.5z"/>
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.9 0 3.2.9.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.7-5.5 6 .5.4.9 1.2.9 2.3v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/>
    </svg>
  )
}
