// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'
import 'openai/shims/node'
import { PrismaClient } from '@prisma/client'

// Global Prisma instance for tests
const prisma = new PrismaClient()

// Cleanup after all tests
afterAll(async () => {
  await prisma.$disconnect()
})

// CRITICAL: Force test database - NEVER use production database
// Tests will fail if TEST_DATABASE_URL is not set
if (!process.env.TEST_DATABASE_URL) {
  console.error('❌ FATAL: TEST_DATABASE_URL environment variable must be set')
  console.error('Example: postgresql://localhost:5432/backenly_test')
  console.error('Never run tests against production database!')
  process.exit(1)
}

// Override DATABASE_URL with test database
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-minimum-32-characters-long'
process.env.NODE_ENV = 'test'
process.env.ENGINE_MODE = 'integration' // Integration tests should not execute real DDL

console.log('✅ Test database configured:', process.env.TEST_DATABASE_URL.replace(/:[^:]*@/, ':***@'))

// Mock Next.js Request/Response
global.Request = class Request {
  constructor(input, init) {
    this.url = typeof input === 'string' ? input : input.url
    this.method = init?.method || 'GET'
    this.headers = new Headers(init?.headers)
    this.body = init?.body
  }
}

global.Response = class Response {
  constructor(body, init) {
    this.body = body
    this.status = init?.status || 200
    this.statusText = init?.statusText || 'OK'
    this.headers = new Headers(init?.headers)
  }

  // NextResponse.json() delegates to this static. Without it any route helper
  // that returns NextResponse.json(...) throws "Response.json is not a
  // function" in tests, which reads like a bug in the code under test.
  static json(data, init) {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    })
  }

  json() {
    return Promise.resolve(JSON.parse(this.body))
  }
}

global.Headers = class Headers {
  constructor(init) {
    this._headers = {}
    if (init) {
      if (init instanceof Headers) {
        init.forEach((value, key) => {
          this._headers[key] = value
        })
      } else if (Array.isArray(init)) {
        init.forEach(([key, value]) => {
          this._headers[key] = value
        })
      } else {
        Object.entries(init).forEach(([key, value]) => {
          this._headers[key] = value
        })
      }
    }
  }
  
  get(name) {
    return this._headers[name.toLowerCase()] || null
  }
  
  set(name, value) {
    this._headers[name.toLowerCase()] = value
  }
  
  has(name) {
    return name.toLowerCase() in this._headers
  }
  
  forEach(callback) {
    Object.entries(this._headers).forEach(([key, value]) => {
      callback(value, key, this)
    })
  }
}

// Suppress console errors in tests unless explicitly testing them
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Warning:') || args[0].includes('Error:'))
    ) {
      return
    }
    originalError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalError
})

