/**
 * A `Request` that `NextRequest` can extend, for tests that run a route which
 * itself constructs a NextRequest.
 *
 * jest.setup.js replaces the global Request with a class that ASSIGNS `url`.
 * NextRequest declares `url` as a getter, so `super()` throws "Cannot set
 * property url of #<NextRequest> which has only a getter" and any route that
 * builds a request in-process (the remote MCP endpoint does, to delegate a tool
 * call) cannot run at all.
 *
 * NextRequest captures the global Request when `next/server` is first loaded,
 * so import this module BEFORE anything that imports `next/server`.
 */

/**
 * jest.setup.js's Headers has no entries(), which NextRequest iterates, and it
 * keeps construction-time keys in their original case while get() lowercases,
 * so `{ 'Content-Type': … }` could not be read back. This one follows the spec
 * closely enough for a route under test: case-insensitive, iterable.
 */
class TestHeaders {
  #map = new Map<string, string>()

  constructor(init?: HeadersInit | TestHeaders) {
    if (!init) return
    const pairs: Iterable<[string, string]> =
      init instanceof TestHeaders
        ? init.entries()
        : Array.isArray(init)
          ? (init as [string, string][])
          : typeof (init as any).entries === 'function'
            ? (init as any).entries()
            : Object.entries(init as Record<string, string>)
    for (const [k, v] of pairs) this.#map.set(k.toLowerCase(), String(v))
  }

  get(name: string): string | null {
    return this.#map.get(name.toLowerCase()) ?? null
  }
  has(name: string): boolean {
    return this.#map.has(name.toLowerCase())
  }
  set(name: string, value: string): void {
    this.#map.set(name.toLowerCase(), String(value))
  }
  append(name: string, value: string): void {
    const prev = this.get(name)
    this.set(name, prev === null ? value : `${prev}, ${value}`)
  }
  delete(name: string): void {
    this.#map.delete(name.toLowerCase())
  }
  forEach(cb: (value: string, key: string, parent: TestHeaders) => void): void {
    for (const [k, v] of this.#map) cb(v, k, this)
  }
  entries(): IterableIterator<[string, string]> {
    return this.#map.entries()
  }
  keys(): IterableIterator<string> {
    return this.#map.keys()
  }
  values(): IterableIterator<string> {
    return this.#map.values()
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#map.entries()
  }
}

;(globalThis as any).Headers = TestHeaders

class TestRequest {
  #url: string
  #body: unknown
  method: string
  headers: Headers

  constructor(input: string | { url: string }, init?: { method?: string; headers?: HeadersInit; body?: unknown }) {
    this.#url = typeof input === 'string' ? input : input.url
    this.method = init?.method || 'GET'
    this.headers = new Headers(init?.headers)
    this.#body = init?.body
  }

  get url(): string {
    return this.#url
  }

  async text(): Promise<string> {
    return this.#body == null ? '' : String(this.#body)
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text())
  }
}

;(globalThis as any).Request = TestRequest

export {}
