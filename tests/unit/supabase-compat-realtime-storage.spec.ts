/**
 * THE SUPABASE-JS SHIM'S REALTIME AND STORAGE (#615)
 * ==================================================
 * `@backenly/sdk/supabase` is the documented way to move a supabase-js frontend
 * to Backenly, and its realtime and storage parts did not work:
 *
 *   postgres_changes   read the row from `row` or `new`, which Backenly never
 *                      sends, so every insert and update arrived with
 *                      `new: null` and a delete with no row at all
 *   event: '*'         also received the stream's `connected` and `error`
 *                      frames as if they were changes
 *   upload()           dropped the bucket and the path, so a file went to the
 *                      `default` bucket under its own name, and a Blob under
 *                      "undefined"
 *   getPublicUrl()     called a method the SDK never had: always null
 *
 * The real client and shim run here, with the browser's fetch and EventSource
 * stood in for, and the frames are the ones Backenly realtime sends a stream
 * that is not a service-role one (lib/realtime/visibility.ts). What the real
 * stream and storage routes do with the shim is pinned in
 * tests/integration/supabase-compat-realtime-storage.spec.ts.
 */

import { createSupabaseCompatClient } from '@backenly/sdk'

jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })

const PROJECT_ID = '0e05907b-dab8-4278-87f1-ba792eb01b36'
const API = 'https://api.backenly.test'

/** The browser's EventSource: one per stream the SDK opens, fed frames by the test. */
class FakeEventSource {
  static readonly CLOSED = 2
  static opened: FakeEventSource[] = []
  readyState = 1
  onmessage: ((msg: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
  /** A frame from the server, as `data: <json>` delivers it. */
  send(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  /** The server ends the stream. */
  drop() {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }
}

const latestStream = () => FakeEventSource.opened[FakeEventSource.opened.length - 1]

interface Upload {
  bucket: FormDataEntryValue | null
  path: FormDataEntryValue | null
  isPublic: FormDataEntryValue | null
  file: FormDataEntryValue | null
}

let uploads: Upload[] = []
/** What the upload route answers next. */
let uploadAnswer: { status: number; body: unknown } = { status: 200, body: {} }

const fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname
  if (path === `/api/v1/${PROJECT_ID}/realtime/ticket`) {
    return { ok: true, status: 200, json: async () => ({ ticket: `ticket-${FakeEventSource.opened.length + 1}` }) }
  }
  if (path === `/api/v1/${PROJECT_ID}/storage/upload`) {
    const form = init!.body as FormData
    uploads.push({ bucket: form.get('bucket'), path: form.get('path'), isPublic: form.get('isPublic'), file: form.get('file') })
    const { status, body } = uploadAnswer
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  throw new Error(`no answer for ${path}`)
})

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeAll(() => {
  // The SDK streams only in a browser.
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: fetchMock,
    EventSource: FakeEventSource,
  })
})
afterAll(() => {
  for (const name of ['window', 'localStorage', 'EventSource']) delete (globalThis as any)[name]
})

const channels: Array<{ supabase: ReturnType<typeof createSupabaseCompatClient>; channel: any }> = []
let warn: jest.SpyInstance

beforeEach(() => {
  FakeEventSource.opened = []
  uploads = []
  fetchMock.mockClear()
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const { supabase, channel } of channels.splice(0)) supabase.removeChannel(channel)
  jest.clearAllTimers()
  warn.mockRestore()
})

const client = () => createSupabaseCompatClient(`${API}/api/v1/${PROJECT_ID}`, 'proj_live_test')

type Payload = { eventType: string; new: Record<string, any>; old: Record<string, any>; table: string; schema: string }

/** A channel as a supabase-js app opens one, once its stream is open. */
async function listen(filters: Array<{ event: string; table: string }>) {
  const supabase = client()
  const received: Payload[] = []
  const statuses: Array<[string, string | undefined]> = []
  let channel = supabase.channel('room')
  for (const filter of filters) {
    channel = channel.on('postgres_changes', { schema: 'public', ...filter }, (payload: Payload) => received.push(payload))
  }
  channel.subscribe((status, err) => statuses.push([status, err?.message]))
  channels.push({ supabase, channel })
  await settle()
  return { received, statuses, stream: latestStream() }
}

describe('postgres_changes payloads', () => {
  it('hands an insert over with the row in `new`', async () => {
    const { received, stream } = await listen([{ event: '*', table: 'messages' }])

    stream.send({ type: 'insert', table: 'messages', data: { id: 'm1', body: 'hello' }, old: null, timestamp: 1 })

    expect(received).toEqual([
      { eventType: 'INSERT', new: { id: 'm1', body: 'hello' }, old: {}, table: 'messages', schema: 'public' },
    ])
  })

  it('hands an update over with the row in `new` and the previous row, as sent, in `old`', async () => {
    const { received, stream } = await listen([{ event: '*', table: 'messages' }])

    stream.send({ type: 'update', table: 'messages', data: { id: 'm1', body: 'edited' }, old: { id: 'm1' }, timestamp: 2 })

    expect(received).toEqual([
      { eventType: 'UPDATE', new: { id: 'm1', body: 'edited' }, old: { id: 'm1' }, table: 'messages', schema: 'public' },
    ])
  })

  it('hands a delete over with the row that went in `old`', async () => {
    const { received, stream } = await listen([{ event: '*', table: 'messages' }])

    stream.send({ type: 'delete', table: 'messages', data: { id: 'm1' }, old: null, timestamp: 3 })

    expect(received).toEqual([{ eventType: 'DELETE', new: {}, old: { id: 'm1' }, table: 'messages', schema: 'public' }])
  })

  it('keeps a handler written for supabase-js in step with the table', async () => {
    const supabase = client()
    const messages = new Map<string, string>()
    const channel = supabase
      .channel('room')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload: Payload) => {
        if (payload.eventType === 'DELETE') messages.delete(payload.old.id)
        else messages.set(payload.new.id, payload.new.body)
      })
      .subscribe()
    channels.push({ supabase, channel })
    await settle()
    const stream = latestStream()

    stream.send({ type: 'connected', projectId: PROJECT_ID, channel: `workspace_${PROJECT_ID}_changes` })
    stream.send({ type: 'insert', table: 'messages', data: { id: 'm1', body: 'hello' }, old: null })
    stream.send({ type: 'insert', table: 'messages', data: { id: 'm2', body: 'there' }, old: null })
    stream.send({ type: 'update', table: 'messages', data: { id: 'm1', body: 'edited' }, old: { id: 'm1' } })
    stream.send({ type: 'delete', table: 'messages', data: { id: 'm2' }, old: null })

    expect([...messages]).toEqual([['m1', 'edited']])
  })

  it('still hands over a change too large to send, with `{}` for the row it does not carry', async () => {
    const { received, stream } = await listen([{ event: '*', table: 'messages' }])

    stream.send({ type: 'insert', table: 'messages', data: null, truncated: true, timestamp: 4 })

    expect(received).toEqual([{ eventType: 'INSERT', new: {}, old: {}, table: 'messages', schema: 'public' }])
  })
})

describe("the stream's own frames", () => {
  it("are never handed to a handler as changes, even with event '*'", async () => {
    const { received, stream } = await listen([
      { event: '*', table: 'messages' },
      { event: 'INSERT', table: 'messages' },
    ])

    stream.send({ type: 'connected', projectId: PROJECT_ID, channel: `workspace_${PROJECT_ID}_changes` })
    stream.send({ type: 'error', message: 'Failed to connect to realtime stream' })
    stream.send({ type: 'delete', table: 'messages', data: { id: 'm1' }, old: null })

    // The delete, to the '*' listener only: the INSERT listener receives no other kind.
    expect(received).toEqual([{ eventType: 'DELETE', new: {}, old: { id: 'm1' }, table: 'messages', schema: 'public' }])
  })

  it("reach subscribe()'s callback: an error as CHANNEL_ERROR, and the reconnection as SUBSCRIBED", async () => {
    const { statuses, stream } = await listen([{ event: '*', table: 'messages' }])
    stream.send({ type: 'connected', projectId: PROJECT_ID, channel: `workspace_${PROJECT_ID}_changes` })
    expect(statuses).toEqual([['SUBSCRIBED', undefined]])

    stream.send({ type: 'error', message: 'Failed to connect to realtime stream' })
    stream.drop()
    expect(statuses).toEqual([
      ['SUBSCRIBED', undefined],
      ['CHANNEL_ERROR', 'Failed to connect to realtime stream'],
    ])

    // The SDK opens a new stream, with a new ticket, and it connects.
    await jest.advanceTimersByTimeAsync(1_250)
    await settle()
    expect(FakeEventSource.opened).toHaveLength(2)
    latestStream().send({ type: 'connected', projectId: PROJECT_ID, channel: `workspace_${PROJECT_ID}_changes` })

    expect(statuses).toEqual([
      ['SUBSCRIBED', undefined],
      ['CHANNEL_ERROR', 'Failed to connect to realtime stream'],
      ['SUBSCRIBED', undefined],
    ])
  })

  it('report a refusal that is final as CHANNEL_ERROR, after which the SDK does not reconnect', async () => {
    const { statuses, stream } = await listen([{ event: '*', table: 'messages' }])

    stream.send({ type: 'error', code: 'PROJECT_PAUSED', message: 'This project is paused.' })
    await jest.advanceTimersByTimeAsync(60_000)
    await settle()

    expect(statuses).toEqual([
      ['SUBSCRIBED', undefined],
      ['CHANNEL_ERROR', 'This project is paused.'],
    ])
    expect(FakeEventSource.opened).toHaveLength(1)
  })

  it('are reported once by a channel listening to two tables', async () => {
    const { statuses, stream } = await listen([
      { event: '*', table: 'messages' },
      { event: '*', table: 'rooms' },
    ])

    stream.send({ type: 'error', message: 'Failed to connect to realtime stream' })

    expect(statuses).toEqual([
      ['SUBSCRIBED', undefined],
      ['CHANNEL_ERROR', 'Failed to connect to realtime stream'],
    ])
  })
})

describe('storage.from(bucket)', () => {
  const stored = {
    status: 200,
    body: {
      success: true,
      data: { id: 'f-1', bucket: 'avatars', path: 'f-1', url: '/api/storage/files/f-1/download', size: 3, isPublic: true },
    },
  }

  it("upload(path, file) sends the bucket and the path, and leaves the file to its bucket's policy", async () => {
    uploadAnswer = stored
    const supabase = client()

    const out = await supabase.storage.from('avatars').upload('folder/me.png', new File(['png'], 'me.png', { type: 'image/png' }))

    // No isPublic: the upload route lets the bucket's access policy decide.
    expect(uploads).toEqual([{ bucket: 'avatars', path: 'folder/me.png', isPublic: null, file: expect.anything() }])
    expect(out).toEqual({ data: { path: 'f-1', id: 'f-1', fullPath: 'f-1' }, error: null })
  })

  it('uploads a Blob under the path it is given', async () => {
    uploadAnswer = stored
    const supabase = client()

    await supabase.storage.from('notes').upload('today.txt', new Blob(['hi'], { type: 'text/plain' }))

    expect(uploads).toEqual([{ bucket: 'notes', path: 'today.txt', isPublic: null, file: expect.anything() }])
  })

  it("gives getPublicUrl() the file's download address on the API's origin", () => {
    const supabase = client()

    const { data } = supabase.storage.from('avatars').getPublicUrl('f-1')

    expect(data.publicUrl).toBe(`${API}/api/storage/files/f-1/download`)
  })

  it('resolves a refused upload as { data: null, error } with the reason, and does not throw', async () => {
    uploadAnswer = {
      status: 404,
      body: { success: false, error: { code: 'NOT_FOUND', message: "Bucket 'avatars' not found in this project" } },
    }
    const supabase = client()

    const out = await supabase.storage.from('avatars').upload('me.png', new File(['png'], 'me.png', { type: 'image/png' }))

    expect(out.data).toBeNull()
    expect(out.error?.message).toContain("Bucket 'avatars' not found in this project")
  })
})
