import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { ACCOUNT_DELETED_URL, deleteAccount, signOut, SIGNED_OUT_URL } from '@/lib/api/auth'
import { checkSession, setSessionCache } from '@/lib/hooks/useUserSession'

/**
 * Signing out ends the session in the browser as well as on the server, and
 * leaves through one full-document replace.
 *
 * Five sign-out controls each had their own handler. Four POSTed to
 * /api/auth/logout and router.push()ed to /login, leaving the localStorage
 * token and the useUserSession cache saying "signed in". The login page read
 * that, bounced to /app, the middleware bounced it back to
 * /auth/login?redirect=%2Fapp, and the user watched a blank frame, an "Already
 * signed in" card and a reload. Back then re-rendered the console, email and
 * all, from module memory.
 */

type Reply = { ok: boolean; status: number; json?: () => Promise<unknown> }

const ORIGINALS = {
  fetch: globalThis.fetch,
  localStorage: (globalThis as any).localStorage,
  window: (globalThis as any).window,
}

afterEach(() => {
  Object.assign(globalThis, ORIGINALS)
})

function browser(opts: { token?: string; reply: (url: string) => Promise<Reply> }) {
  const store = new Map<string, string>([
    ['current-project-id', 'p1'],
    ['user-info', '{}'],
    ['sidebarCollapsed', 'true'],
  ])
  if (opts.token) store.set('auth-token', opts.token)
  const requests: { url: string; init?: RequestInit }[] = []
  const replace = jest.fn()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    window: { location: { replace } },
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return opts.reply(url)
    },
  })
  return { store, requests, replace }
}

const ok: Reply = { ok: true, status: 200 }

describe('signOut', () => {
  it('lands on the login page the console redirects to', () => {
    expect(SIGNED_OUT_URL).toBe('/auth/login?redirect=%2Fapp')
  })

  it('asks the server to end the session with every credential the browser holds', async () => {
    const b = browser({ token: 'jwt-1', reply: async () => ok })
    await signOut()
    expect(b.requests).toHaveLength(1)
    expect(b.requests[0].url).toBe('/api/auth/logout')
    expect(b.requests[0].init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer jwt-1' },
    })
  })

  it('still asks the server when only the httpOnly cookie holds the session', async () => {
    const b = browser({ reply: async () => ok })
    await signOut()
    expect(b.requests).toHaveLength(1)
    expect(b.requests[0].init?.credentials).toBe('include')
    expect(b.requests[0].init?.headers).toBeUndefined()
  })

  it('clears the client session and replaces the document, once', async () => {
    const b = browser({ token: 'jwt-1', reply: async () => ok })
    await signOut()
    expect(b.store.has('auth-token')).toBe(false)
    expect(b.store.has('current-project-id')).toBe(false)
    expect(b.store.has('user-info')).toBe(false)
    // Preferences are not the session.
    expect(b.store.get('sidebarCollapsed')).toBe('true')
    expect(b.replace).toHaveBeenCalledTimes(1)
    expect(b.replace).toHaveBeenCalledWith(SIGNED_OUT_URL)
  })

  it('forgets the cached "signed in" that the login page trusts without asking', async () => {
    setSessionCache({ id: 'u1', email: 'a@b.c' }, true)
    const b = browser({
      token: 'jwt-1',
      reply: async (url) => (url === '/api/auth/logout' ? ok : { ok: false, status: 401 }),
    })
    await signOut()
    const session = await checkSession()
    expect(session.isLoggedIn).toBe(false)
    expect(b.requests.map((r) => r.url)).toContain('/api/auth/me')
  })

  it('does not read a 401 as "already signed out"', async () => {
    // The route clears this browser's credentials whatever state the session is
    // in, so a 401 means it did not run. Reading it as success once left a live
    // refresh cookie behind that signed the browser straight back in.
    const b = browser({ token: 'jwt-1', reply: async () => ({ ok: false, status: 401 }) })
    await expect(signOut()).rejects.toThrow('Sign-out failed (401)')
    expect(b.store.get('auth-token')).toBe('jwt-1')
    expect(b.replace).not.toHaveBeenCalled()
  })

  it('leaves the user signed in and in place when the server could not end the session', async () => {
    const failed = browser({ token: 'jwt-1', reply: async () => ({ ok: false, status: 500 }) })
    await expect(signOut()).rejects.toThrow('Sign-out failed (500)')
    expect(failed.store.get('auth-token')).toBe('jwt-1')
    expect(failed.replace).not.toHaveBeenCalled()

    const offline = browser({ token: 'jwt-1', reply: async () => { throw new TypeError('Failed to fetch') } })
    await expect(signOut()).rejects.toThrow('Failed to fetch')
    expect(offline.store.get('auth-token')).toBe('jwt-1')
    expect(offline.replace).not.toHaveBeenCalled()
  })
})

describe('deleteAccount', () => {
  it('leaves the same way signing out does, once the server has deleted the account', async () => {
    setSessionCache({ id: 'u1', email: 'a@b.c' }, true)
    const b = browser({
      token: 'jwt-1',
      reply: async (url) => (url === '/api/auth/delete-account' ? ok : { ok: false, status: 401 }),
    })
    await deleteAccount()

    expect(b.requests[0]).toMatchObject({ url: '/api/auth/delete-account', init: { method: 'DELETE', credentials: 'include' } })
    expect(b.store.has('auth-token')).toBe(false)
    expect(b.store.has('current-project-id')).toBe(false)
    expect(b.store.has('user-info')).toBe(false)
    expect(b.store.get('sidebarCollapsed')).toBe('true')
    expect(b.replace).toHaveBeenCalledTimes(1)
    expect(b.replace).toHaveBeenCalledWith(ACCOUNT_DELETED_URL)
    expect((await checkSession()).isLoggedIn).toBe(false)
  })

  it('changes nothing in this browser when the server refused', async () => {
    const b = browser({
      token: 'jwt-1',
      reply: async () => ({ ok: false, status: 409, json: async () => ({ error: 'Account has too many projects' }) }),
    })
    await expect(deleteAccount()).rejects.toThrow('Account has too many projects')
    expect(b.store.get('auth-token')).toBe('jwt-1')
    expect(b.replace).not.toHaveBeenCalled()
  })
})

describe('sign-out stays in one place', () => {
  const ROOT = process.cwd()

  function sources(dir: string): string[] {
    return readdirSync(join(ROOT, dir)).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(join(ROOT, path)).isDirectory()) return name === 'api' && dir === 'app' ? [] : sources(path)
      return /\.(ts|tsx)$/.test(name) ? [path] : []
    })
  }

  it.each(['logout', 'delete-account'])('no control calls /api/auth/%s itself', (endpoint) => {
    // app/api is the server; the platform's own client helper is lib/api/auth.ts.
    const literal = new RegExp(`['"\`]/api/auth/${endpoint}`)
    const offenders = ['app', 'components', 'lib']
      .flatMap(sources)
      .filter((path) => literal.test(readFileSync(join(ROOT, path), 'utf8')))
      .map((path) => path.replace(/\\/g, '/'))
    expect(offenders).toEqual([])
  })

  it.each(['app/api/auth/logout/route.ts', 'app/api/auth/delete-account/route.ts'])(
    '%s clears the cookies a session actually uses',
    (route) => {
      // delete-account used to clear a cookie named `token`, which nothing sets.
      const src = readFileSync(join(ROOT, route), 'utf8')
      expect(src).toContain('clearSessionCookies(')
      expect(src).not.toMatch(/cookies\.(set|delete)\(\s*['"]token['"]/)
    },
  )
})
