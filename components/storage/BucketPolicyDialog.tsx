'use client'

/**
 * WHO MAY READ THIS BUCKET
 *
 * The four policies already existed in the database. What did not exist was
 * anywhere to see or change them, and — more importantly — the serving path did
 * not read them: it gated on a flag copied onto each file at upload time. So an
 * operator who made a bucket private got a success response and every object
 * already in it stayed world-readable.
 *
 * That is fixed in `lib/storage/access-policy.ts`, and this is the surface for
 * it. Two things it deliberately does:
 *
 * ── It says what each policy MEANS, not just its name ───────────────────────
 *
 * `owner_only` in particular, because until now it was accepted, stored, and
 * behaved exactly like `private`. An operator choosing it was choosing a label.
 *
 * ── It states the one case the policy cannot govern ─────────────────────────
 *
 * With the S3 driver and a public CDN base configured, a public object's URL
 * points at the CDN rather than at this deployment. Those reads never reach the
 * code that enforces this policy, so tightening a bucket cannot revoke them
 * until the CDN object or cache is purged.
 *
 * Saying so where the choice is made is the honest option. The alternative is a
 * control that silently does not apply to the configuration serving the most
 * traffic — which is the exact class of defect this whole tranche came from.
 */

import { useState } from 'react'
import { AlertTriangle, Loader2, Lock } from 'lucide-react'
import { KitButton, KitModal, KitNote } from '@/components/inspector/kit'
import { ACCESS_POLICIES, POLICY_LABELS, type AccessPolicy } from '@/lib/storage/access-policy'

export function BucketPolicyDialog({
  bucketName,
  current,
  cdnCaveat,
  onClose,
  onSave,
}: {
  bucketName: string
  current: string
  /** True when a public CDN base is configured, so public reads bypass this app. */
  cdnCaveat: boolean
  onClose: () => void
  onSave: (policy: AccessPolicy) => Promise<void>
}) {
  const initial = (ACCESS_POLICIES as readonly string[]).includes(current)
    ? (current as AccessPolicy)
    : 'private'
  const [policy, setPolicy] = useState<AccessPolicy>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loosening =
    (initial === 'private' || initial === 'owner_only') &&
    (policy === 'public_read' || policy === 'cdn_cacheable')

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await onSave(policy)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The policy could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open
      title={`Who may read ${bucketName}`}
      description="Applies to every object in this bucket, from the next request onwards."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            icon={busy ? Loader2 : Lock}
            disabled={busy || policy === initial}
            onClick={save}
          >
            {busy ? 'Applying…' : 'Apply'}
          </KitButton>
        </>
      }
    >
      <div className="space-y-3">
        {ACCESS_POLICIES.map(option => (
          <label
            key={option}
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
              policy === option
                ? 'border-violet-400/30 bg-violet-400/[0.06]'
                : 'border-white/[0.06] hover:border-white/15'
            }`}
          >
            <input
              type="radio"
              name="bucket-policy"
              value={option}
              checked={policy === option}
              onChange={() => setPolicy(option)}
              className="mt-0.5 accent-violet-400"
            />
            <span className="min-w-0">
              <span className="block text-[12px] text-zinc-200">
                {POLICY_LABELS[option].title}
                <span className="ml-1.5 font-mono text-[12px] text-zinc-500">{option}</span>
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-zinc-500">
                {POLICY_LABELS[option].means}
              </span>
            </span>
          </label>
        ))}

        {/* Objects individually marked private stay private when a bucket is
            opened, and an operator should not be surprised by that. */}
        {loosening && (
          <KitNote icon={AlertTriangle} tone="warn">
            Objects already marked private stay private. Opening a bucket raises the
            ceiling; it does not publish what was deliberately held back inside it.
          </KitNote>
        )}

        {cdnCaveat && (policy === 'public_read' || policy === 'cdn_cacheable') && (
          <KitNote icon={AlertTriangle} tone="warn" title="A CDN is serving public objects">
            This deployment has a public CDN base configured, so a public object&rsquo;s URL
            points at the CDN rather than at Backenly. Those reads never reach this
            deployment, which means making this bucket private later will not revoke
            them until the CDN object or cache is purged.
          </KitNote>
        )}

        {error && <KitNote icon={AlertTriangle} tone="danger">{error}</KitNote>}
      </div>
    </KitModal>
  )
}
