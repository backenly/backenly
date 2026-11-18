'use client'

/**
 * WHO CAN UPLOAD TO THIS BUCKET
 *
 * A bucket says who may upload into it (lib/storage/upload-access.ts): the
 * app's signed-in users, or only its server, with a service-role key. This is
 * where a person sees and changes it, beside the read rule
 * (BucketPolicyDialog). It applies from the next upload, and the change is one
 * entry in History, which can put it back.
 */

import { useId, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { KitButton, KitModal, KitNote, KitRadio } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { UPLOAD_RULES, type UploadRule } from '@/lib/storage/upload-access'
import { UPLOAD_WORDS, uploadsOf } from './format'

export function BucketUploadsDialog({
  bucketName,
  current,
  onClose,
  onSave,
}: {
  bucketName: string
  current: string | null | undefined
  onClose: () => void
  onSave: (uploads: UploadRule) => Promise<void>
}) {
  const initial = uploadsOf(current)
  const [uploads, setUploads] = useState<UploadRule>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const groupLabel = useId()

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await onSave(uploads)
    } catch (err) {
      // The server's own words: a refusal names what to change.
      setError(err instanceof Error ? err.message : 'Who can upload was not changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open
      title={
        <>
          Who can upload to <span className="font-mono text-[14px] font-medium">{bucketName}</span>
        </>
      }
      description="Applies from the next upload into this bucket."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={save} loading={busy} disabled={uploads === initial}>
            Save
          </KitButton>
        </>
      }
    >
      <div className="space-y-[14px]">
        <p id={groupLabel} className="sr-only">
          Who can upload to {bucketName}
        </p>
        <div role="radiogroup" aria-labelledby={groupLabel} className="space-y-[12px]">
          {UPLOAD_RULES.map((option) => (
            <KitRadio
              key={option}
              name="bucket-uploads"
              value={option}
              checked={uploads === option}
              onChange={(v) => setUploads(v as UploadRule)}
              label={UPLOAD_WORDS[option].title}
              description={UPLOAD_WORDS[option].means}
              disabled={busy}
            />
          ))}
        </div>

        {/* What changes for the app, said before it does. */}
        {uploads !== initial && uploads === 'signed_in' && (
          <KitNote icon={AlertTriangle} tone="warn">
            Anyone who signs up for your app can then add files to this bucket.
          </KitNote>
        )}
        {uploads !== initial && uploads === 'server_only' && (
          <KitNote icon={AlertTriangle} tone="warn">
            Uploads from your app’s users are refused from then on, including ones already under way.
          </KitNote>
        )}

        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}
