/**
 * presence.join() answers with the server's verdict (#619).
 *
 * The presence routes refuse a public-key caller with no signed-in user (401
 * PRESENCE_TOKEN_REQUIRED) and one announcing anyone but themselves (403
 * PRESENCE_IDENTITY_MISMATCH), on both runtimes (server/routes/presence.ts and
 * app/api/v1/[projectId]/presence/route.ts). The SDK never read the answer:
 * join() resolved, the user never appeared in anyone's list, and a heartbeat
 * went on posting refused requests every 25 seconds.
 *
 * Here fetch answers as the routes do and the module is driven through join,
 * update, leave and the heartbeat, including answers that arrive after a later
 * call. What the real routes answer the published client is pinned in
 * tests/integration/sdk-presence-refusals.spec.ts.
 */

jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })

import { format } from 'util'
import { BackenlyClient, BackenlyError } from '@backenly/sdk'

const HEARTBEAT_MS = 25_000

type Answer = { status: number; body?: unknown } | Error
const OK: Answer = { status: 200, body: { success: true } }
// As the routes answer them.
const TOKEN_REQUIRED = {
  status: 401,
  body: {
    error:
      "Presence identifies callers by their sign-in. Send the end user's X-User-Token " +
      'together with the public key, or use a service-role key for server-side presence.',
    code: 'PRESENCE_TOKEN_REQUIRED',
  },
}
const MISMATCH = {
  status: 403,
  body: { error: 'The signed-in user may only announce or clear presence as themselves.', code: 'PRESENCE_IDENTITY_MISMATCH' },
}
const BLOCKED = { status: 403, body: { error: 'This account has been blocked by the project owner.', code: 'END_USER_BLOCKED' } }
const FAILED = { status: 500, body: { error: 'Presence update failed' } }
const TOO_LARGE = {
  status: 413,
  body: { error: 'Presence metadata is too large to announce.', code: 'PRESENCE_METADATA_TOO_LARGE' },
}

/** The answers the next POSTs get, in order; an empty queue answers OK. A promise is an answer held back. */
let answers: Array<Answer | Promise<Answer>> = []
let posts: Array<{ userId: string; metadata: Record<string, unknown> }> = []
let deletes: string[] = []

function hold(): { answer: Promise<Answer>; release: (answer: Answer) => void } {
  let release!: (answer: Answer) => void
  const answer = new Promise<Answer>((resolve) => (release = resolve))
  return { answer, release }
}

const fetchMock = jest.fn(async (input: string, init: RequestInit) => {
  if (init.method === 'DELETE') {
    deletes.push(new URL(input).searchParams.get('userId')!)
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }
  posts.push(JSON.parse(String(init.body)))
  const answer = await (answers.shift() ?? OK)
  if (answer instanceof Error) throw answer
  return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body }
})

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}
/** Let `beats` heartbeats fire, each answered before the next. */
async function beat(beats = 1) {
  for (let i = 0; i < beats; i++) {
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS)
    await settle()
  }
}

let warn: jest.SpyInstance
const win = { addEventListener: jest.fn(), removeEventListener: jest.fn() }
const last = () => posts[posts.length - 1]
const presence = () => {
  const client = new BackenlyClient({ projectId: 'p-1', apiKey: 'proj_live_test', apiUrl: 'https://api.backenly.test' })
  client.setUserToken('alice-token')
  return client.presence
}

beforeAll(() => {
  // join() is a browser call: it does nothing where there is no window.
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: win,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: fetchMock,
  })
})
afterAll(() => {
  delete (globalThis as any).window
  delete (globalThis as any).localStorage
})
beforeEach(() => {
  answers = []
  posts = []
  deletes = []
  fetchMock.mockClear()
  win.addEventListener.mockClear()
  win.removeEventListener.mockClear()
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.clearAllTimers()
  warn.mockRestore()
})

describe('join()', () => {
  it.each([
    ['before sign-in', TOKEN_REQUIRED],
    ["for anyone but the signed-in user, such as a username or an email", MISMATCH],
    ['for a blocked user', BLOCKED],
  ])("rejects %s with the server's code, status and words, and leaves nothing running", async (_, refusal) => {
    answers.push(refusal)
    const p = presence()

    const joining = p.join('alice', { name: 'Alice' })
    await expect(joining).rejects.toBeInstanceOf(BackenlyError)
    await expect(joining).rejects.toMatchObject({ code: refusal.body.code, status: refusal.status, message: refusal.body.error })

    await beat(4)
    await p.update({ name: 'Al' })
    await p.leave()
    expect(posts).toHaveLength(1)
    expect(deletes).toEqual([])
    expect(win.addEventListener).not.toHaveBeenCalled()
  })

  it('rejects a server failure and a dropped connection as BackenlyErrors too, and leaves nothing running', async () => {
    answers.push(FAILED, new TypeError('fetch failed'))
    const p = presence()

    await expect(p.join('alice')).rejects.toMatchObject({ name: 'BackenlyError', status: 500, message: 'Presence update failed' })
    await expect(p.join('alice')).rejects.toMatchObject({ name: 'BackenlyError', message: 'fetch failed' })
    await beat(2)
    expect(posts).toHaveLength(2)
  })

  it('resolves once the server has the user online, and the heartbeat keeps them there', async () => {
    const p = presence()
    await expect(p.join('alice', { name: 'Alice' })).resolves.toBeUndefined()
    await beat(2)

    expect(posts).toEqual(Array(3).fill({ userId: 'alice', metadata: { name: 'Alice' } }))
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('for the user already online, keeps them online as before when the change fails for a reason but who they are', async () => {
    const p = presence()
    await p.join('alice', { name: 'Alice' })
    answers.push(FAILED)

    await expect(p.join('alice', { name: 'Alice B' })).rejects.toMatchObject({ status: 500 })
    await beat(1)
    expect(last()).toEqual({ userId: 'alice', metadata: { name: 'Alice' } })
  })

  it('for the user already online, ends the session when refused for who they are', async () => {
    const p = presence()
    await p.join('alice', { name: 'Alice' })
    answers.push(TOKEN_REQUIRED)

    await expect(p.join('alice', { name: 'Alice B' })).rejects.toMatchObject({ code: 'PRESENCE_TOKEN_REQUIRED' })
    await beat(3)
    expect(posts).toHaveLength(2)
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('the heartbeat', () => {
  it.each([TOKEN_REQUIRED, MISMATCH])('stops when refused with $status $body.code, and says why once', async (refusal) => {
    const p = presence()
    await p.join('alice')
    answers.push(refusal)

    await beat(4)
    expect(posts).toHaveLength(2)
    expect(win.removeEventListener).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map((call) => format(...call))).toEqual([
      `[Backenly Presence] Stopped announcing alice, refused with ${refusal.body.code}: ${refusal.body.error}`,
    ])
    // Ended here as leave() ends it, so update() has no one to announce.
    await p.update({ name: 'Al' })
    expect(posts).toHaveLength(2)
  })

  it('goes on through a server failure or a dropped connection', async () => {
    const p = presence()
    await p.join('alice')
    answers.push(FAILED, new TypeError('fetch failed'))

    await beat(4)
    expect(posts).toHaveLength(5)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('update()', () => {
  it("rejects with the server's code, and refused for who the user is, ends the session", async () => {
    const p = presence()
    await p.join('alice', { name: 'Alice' })
    answers.push(MISMATCH)

    await expect(p.update({ status: 'away' })).rejects.toMatchObject({ code: 'PRESENCE_IDENTITY_MISMATCH', status: 403 })
    await beat(3)
    expect(posts).toHaveLength(2)
  })

  it('rejects any other failure, and the heartbeat goes on announcing what the server last took', async () => {
    const p = presence()
    await p.join('alice', { name: 'Alice' })
    answers.push(TOO_LARGE)

    await expect(p.update({ bio: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'PRESENCE_METADATA_TOO_LARGE', status: 413 })
    await beat(1)
    expect(last()).toEqual({ userId: 'alice', metadata: { name: 'Alice' } })
  })
})

describe('an answer that arrives after a later call decides nothing', () => {
  it('a refused join, answered after the user left and joined again, leaves the new session running', async () => {
    const held = hold()
    answers.push(held.answer)
    const p = presence()
    const first = p.join('alice', { name: 'first' })
    await settle()
    await p.leave()
    await p.join('alice', { name: 'second' })

    held.release(TOKEN_REQUIRED)
    await expect(first).rejects.toMatchObject({ code: 'PRESENCE_TOKEN_REQUIRED' })
    await beat(1)
    expect(posts).toHaveLength(3)
    expect(last()).toEqual({ userId: 'alice', metadata: { name: 'second' } })
  })

  it('a heartbeat refused while a join is on its way leaves the join to decide', async () => {
    const p = presence()
    await p.join('alice', { name: 'Alice' })
    const held = hold()
    answers.push(held.answer, TOKEN_REQUIRED)
    // A new sign-in's join, sent before the beat that still carries the old token.
    const rejoin = p.join('alice', { name: 'Alice again' })
    await settle()
    await beat(1)

    held.release(OK)
    await expect(rejoin).resolves.toBeUndefined()
    await beat(1)
    expect(posts).toHaveLength(4)
    expect(last()).toEqual({ userId: 'alice', metadata: { name: 'Alice again' } })
    expect(warn).not.toHaveBeenCalled()
  })

  it("a heartbeat refused for an earlier user does not end the next user's session", async () => {
    const p = presence()
    await p.join('alice')
    const held = hold()
    answers.push(held.answer)
    await beat(1)
    await p.leave()
    await p.join('bob')

    held.release(MISMATCH)
    await settle()
    await beat(1)
    expect(posts).toHaveLength(4)
    expect(last()).toEqual({ userId: 'bob', metadata: {} })
    expect(warn).not.toHaveBeenCalled()
  })
})
