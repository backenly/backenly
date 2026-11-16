'use client'

/**
 * WHO CAN READ THIS BUCKET
 *
 * The four policies already existed in the database. What did not exist was
 * anywhere to see or change them, and the serving path did not read them: it
 * gated on a flag copied onto each file at upload time. So an operator who made
 * a bucket private got a success response and every file already in it stayed
 * world-readable. That is fixed in `lib/storage/access-policy.ts`, which
 * evaluates the bucket's policy on every request; this is the surface for it.
 *
 * Each option says what it MEANS in plain words, `owner_only` in particular,
 * which for a long time was accepted, stored and behaved exactly like
 * `private`. And the dialog states the one case a policy cannot govern: with a
 * public CDN base configured, a public file's URL points at the CDN, so those
 * reads never reach the code that enforces the policy and tightening the bucket
 * cannot revoke them until the CDN cache is purged.
 */

import { useId, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { KitButton, KitModal, KitNote, KitRadio } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { ACCESS_POLICIES, type AccessPolicy } from '@/lib/storage/access-policy'
import { POLICY_WORDS, isPublicPolicy, policyOf } from './format'

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
  const initial = policyOf(current)
  const [policy, setPolicy] = useState<AccessPolicy>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const groupLabel = useId()

  const opening = !isPublicPolicy(initial) && isPublicPolicy(policy)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await onSave(policy)
    } catch (err) {
      // The server's own words: a refusal names what to change.
      setError(err instanceof Error ? err.message : 'The read rule could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open
      title={
        <>
          Who can read <span className="font-mono text-[14px] font-medium">{bucketName}</span>
        </>
      }
      description="Applies to every file in this bucket from the next request."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={save} loading={busy} disabled={policy === initial}>
            Save
          </KitButton>
        </>
      }
    >
      <div className="space-y-[14px]">
        <p id={groupLabel} className="sr-only">
          Read rule for {bucketName}
        </p>
        <div role="radiogroup" aria-labelledby={groupLabel} className="space-y-[12px]">
          {ACCESS_POLICIES.map((option) => (
            <KitRadio
              key={option}
              name="bucket-policy"
              value={option}
              checked={policy === option}
              onChange={(v) => setPolicy(v as AccessPolicy)}
              label={POLICY_WORDS[option].title}
              description={POLICY_WORDS[option].means}
              disabled={busy}
            />
          ))}
        </div>

        {/* A file held back as private stays private when its bucket opens. */}
        {opening && (
          <KitNote icon={AlertTriangle} tone="warn">
            Files already marked private stay private; opening the bucket doesn’t publish them.
          </KitNote>
        )}

        {cdnCaveat && isPublicPolicy(policy) && (
          <KitNote icon={AlertTriangle} tone="warn">
            A CDN serves public files here, so making this bucket private later won’t revoke them until the CDN cache is purged.
          </KitNote>
        )}

        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}
