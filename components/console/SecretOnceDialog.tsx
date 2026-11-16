'use client'

/**
 * A secret shown once: a new API key, a webhook's signing secret, a database
 * password. One of the three things a dialog is for (decision 6: create,
 * confirm, show a secret once).
 *
 *   Signing secret for orders-webhook
 *   Copy it now. It is not shown again.
 *   ┌ whsec_9f2c…                                                 Copy ┐
 *   {extra: where to put it}
 *                                                                 [Done]
 *
 * The value is shown in full and wraps, so it can be read and checked; Copy
 * copies it exactly.
 */

import type { ReactNode } from 'react'
import { CopyField, KitButton, KitModal } from '@/components/inspector/kit'

export interface SecretOnceDialogProps {
  open: boolean
  onClose: () => void
  /** "API key for mobile app", "Signing secret for orders-webhook". */
  title: ReactNode
  /** The secret itself. */
  value: string
  /** The copy button's name, "Copy key". */
  copyLabel?: string
  /** One sentence under the title. */
  description?: ReactNode
  /** What to do with it, under the value: an env name to set, a snippet. */
  children?: ReactNode
  doneLabel?: string
}

export function SecretOnceDialog({
  open,
  onClose,
  title,
  value,
  copyLabel = 'Copy',
  description = 'Copy it now. It is not shown again.',
  children,
  doneLabel = 'Done',
}: SecretOnceDialogProps) {
  return (
    <KitModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="max-w-[520px]"
      footer={
        <KitButton variant="primary" onClick={onClose}>
          {doneLabel}
        </KitButton>
      }
    >
      <CopyField value={value} wrap label={copyLabel} />
      {children && <div className="mt-[14px] text-[13px] leading-[20px] text-zinc-400">{children}</div>}
    </KitModal>
  )
}
