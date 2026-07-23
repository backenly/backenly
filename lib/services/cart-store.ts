/**
 * CART STORE
 * ==========
 * Server-side in-memory cart store keyed by (projectId, sessionId).
 * Uses a global Map so state persists across requests on the same Node.js
 * process (Hetzner VPS with PM2 — single long-lived process per app).
 *
 * Cart identity: clients pass `X-Cart-Session` header or `cartSession`
 * query param. If omitted, the API key ID is used as the session key
 * so every API key gets its own cart (useful for service-role testing).
 */

export interface CartItem {
  productId: string
  quantity: number
  /** Snapshot of price at add-time (fetched from products table) */
  price: number
  /** Snapshot of product name at add-time */
  name: string
}

export interface Cart {
  sessionId: string
  projectId: string
  items: CartItem[]
  createdAt: string
  updatedAt: string
}

// ── Global cart store ─────────────────────────────────────────────────────────
// Survives across requests on the same process. TTL: 24 h.

declare global {
  // eslint-disable-next-line no-var
  var __cartStore: Map<string, Cart> | undefined
  // eslint-disable-next-line no-var
  var __cartTtlStore: Map<string, ReturnType<typeof setTimeout>> | undefined
}

const CART_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

function getStore(): Map<string, Cart> {
  if (!global.__cartStore) global.__cartStore = new Map()
  return global.__cartStore
}

function getTtlStore(): Map<string, ReturnType<typeof setTimeout>> {
  if (!global.__cartTtlStore) global.__cartTtlStore = new Map()
  return global.__cartTtlStore
}

function cartKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`
}

function resetTtl(key: string): void {
  const ttls = getTtlStore()
  const existing = ttls.get(key)
  if (existing) clearTimeout(existing)
  ttls.set(key, setTimeout(() => {
    getStore().delete(key)
    ttls.delete(key)
  }, CART_TTL_MS))
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getCart(projectId: string, sessionId: string): Cart {
  const key = cartKey(projectId, sessionId)
  const store = getStore()
  if (!store.has(key)) {
    const now = new Date().toISOString()
    store.set(key, { sessionId, projectId, items: [], createdAt: now, updatedAt: now })
  }
  resetTtl(key)
  return store.get(key)!
}

export function cartWithTotals(cart: Cart): Cart & { subtotal: number; itemCount: number } {
  const subtotal = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  const itemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0)
  return { ...cart, subtotal: Math.round(subtotal * 100) / 100, itemCount }
}

export function addToCart(
  projectId: string,
  sessionId: string,
  item: CartItem,
): Cart {
  const cart = getCart(projectId, sessionId)
  const existing = cart.items.find(i => i.productId === item.productId)
  if (existing) {
    existing.quantity += item.quantity
  } else {
    cart.items.push({ ...item })
  }
  cart.updatedAt = new Date().toISOString()
  return cart
}

export function updateCartItem(
  projectId: string,
  sessionId: string,
  productId: string,
  quantity: number,
): Cart | null {
  const cart = getCart(projectId, sessionId)
  const item = cart.items.find(i => i.productId === productId)
  if (!item) return null
  if (quantity <= 0) {
    cart.items = cart.items.filter(i => i.productId !== productId)
  } else {
    item.quantity = quantity
  }
  cart.updatedAt = new Date().toISOString()
  return cart
}

export function removeFromCart(
  projectId: string,
  sessionId: string,
  productId: string,
): Cart {
  const cart = getCart(projectId, sessionId)
  cart.items = cart.items.filter(i => i.productId !== productId)
  cart.updatedAt = new Date().toISOString()
  return cart
}

export function clearCart(projectId: string, sessionId: string): void {
  const key = cartKey(projectId, sessionId)
  getStore().delete(key)
  const ttls = getTtlStore()
  const existing = ttls.get(key)
  if (existing) clearTimeout(existing)
  ttls.delete(key)
}

/** Extract session ID from request headers / query params */
export function resolveSessionId(
  request: { headers: { get: (k: string) => string | null }; nextUrl?: { searchParams: URLSearchParams } },
  fallback: string,
): string {
  const header = request.headers.get('x-cart-session')
  if (header && header.trim()) return header.trim()
  const param = request.nextUrl?.searchParams.get('cartSession')
  if (param && param.trim()) return param.trim()
  return fallback
}
