'use client'

/**
 * Add or edit an endpoint: its URL, one event, and for a row event every
 * table or the ones picked.
 *
 * The events are rendered from WEBHOOK_EVENT_TYPES rather than written out
 * here. The old route validated against a hand-written array that omitted
 * `row.updated` while the type union included it, so a picker built from the
 * type would have offered an option the API rejects. One list, one answer.
 *
 * The dialog stays open until the server agrees: a refusal (a blocked
 * destination, a table that does not exist) shows under the fields in the
 * server's words, and nothing on the page changes.
 */

import { useEffect, useId, useState } from 'react'
import { KitButton, KitCheckbox, KitField, KitInput, KitModal, KitRadio } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { WEBHOOK_EVENT_TYPES, EVENT_DESCRIPTIONS, isRowEventType, type WebhookEventType } from '@/lib/webhooks/events'

const NO_TABLES: string[] = []

export function WebhookForm({
  open,
  title,
  initialUrl = '',
  initialEvent = 'row.inserted',
  initialTables = NO_TABLES,
  availableTables,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  initialUrl?: string
  initialEvent?: WebhookEventType
  /** Row events only: the tables it receives; empty means every table. */
  initialTables?: string[]
  availableTables: string[]
  onClose: () => void
  /** Resolves once the server has saved it; throws with the server's words otherwise. */
  onSubmit: (eventType: WebhookEventType, targetUrl: string, tables: string[]) => Promise<void>
}) {
  const [url, setUrl] = useState(initialUrl)
  const [event, setEvent] = useState<WebhookEventType>(initialEvent)
  const [someTables, setSomeTables] = useState(initialTables.length > 0)
  const [picked, setPicked] = useState<string[]>(initialTables)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventLabel = useId()
  const tablesLabel = useId()

  useEffect(() => {
    if (open) {
      setUrl(initialUrl)
      setEvent(initialEvent)
      setSomeTables(initialTables.length > 0)
      setPicked(initialTables)
      setError(null)
    }
  }, [open, initialUrl, initialEvent, initialTables])

  const rowEvent = isRowEventType(event)
  // A sign-up comes from no table; "every table" sends none.
  const tables = rowEvent && someTables ? picked : []
  const missingTables = rowEvent && someTables && picked.length === 0
  const togglePicked = (table: string) =>
    setPicked((prev) => (prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]))

  async function submit() {
    if (busy || url.trim() === '' || missingTables) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(event, url.trim(), tables)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The endpoint could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open={open}
      title={title}
      onClose={onClose}
      width="max-w-[520px]"
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose}>
            Cancel
          </KitButton>
          <KitButton variant="primary" loading={busy} disabled={url.trim() === '' || missingTables} onClick={submit}>
            {busy ? 'Saving…' : 'Save endpoint'}
          </KitButton>
        </>
      }
    >
      <div className="space-y-[20px]">
        <KitField label="URL" hint="Must be reachable from the internet.">
          <KitInput
            type="url"
            inputMode="url"
            name="webhook-url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder="https://example.com/hooks/backenly"
            className="font-mono"
          />
        </KitField>

        <div role="radiogroup" aria-labelledby={eventLabel}>
          <p id={eventLabel} className="mb-[8px] text-[12.5px] font-medium leading-[18px] text-zinc-300">
            Event
          </p>
          <div className="space-y-[10px]">
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <KitRadio
                key={type}
                name="webhook-event"
                value={type}
                checked={event === type}
                onChange={() => setEvent(type)}
                label={<code className="font-mono text-[12.5px] text-zinc-100">{type}</code>}
                description={EVENT_DESCRIPTIONS[type]}
              />
            ))}
          </div>
        </div>

        {rowEvent && (
          <div role="radiogroup" aria-labelledby={tablesLabel}>
            <p id={tablesLabel} className="mb-[8px] text-[12.5px] font-medium leading-[18px] text-zinc-300">
              Tables
            </p>
            <div className="space-y-[10px]">
              <KitRadio name="webhook-tables" value="every" checked={!someTables} onChange={() => setSomeTables(false)} label="Every table" />
              <KitRadio name="webhook-tables" value="some" checked={someTables} onChange={() => setSomeTables(true)} label="Only the tables I pick" />
            </div>
            {someTables &&
              (availableTables.length === 0 ? (
                <p className="mt-[10px] pl-[26px] text-[12.5px] leading-[18px] text-faint">This project has no tables yet.</p>
              ) : (
                <div className="mt-[10px] flex flex-wrap gap-x-[20px] gap-y-[10px] pl-[26px]" role="group" aria-label="Tables to send">
                  {availableTables.map((table) => (
                    <KitCheckbox
                      key={table}
                      name="webhook-table"
                      value={table}
                      checked={picked.includes(table)}
                      onChange={() => togglePicked(table)}
                      label={<span className="font-mono text-[12.5px]">{table}</span>}
                    />
                  ))}
                </div>
              ))}
          </div>
        )}

        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}
