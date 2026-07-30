const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
})

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node', // Use node environment for API tests
  testTimeout: 20000, // 20 second timeout for integration tests
  moduleNameMapper: {
    // The SDK subpath exports resolve through `exports` in its package.json,
    // which ts-jest's CommonJS transform does not honour. Map them at source so
    // a test imports the same module graph a consumer does.
    '^@backenly/sdk/supabase$': '<rootDir>/packages/sdk/src/supabase-compat.ts',
    '^@backenly/sdk$': '<rootDir>/packages/sdk/src/index.ts',
    // The SDK sources carry explicit `.js` extensions so the published ESM build
    // is resolvable by Node. Strip them for ts-jest, which reads the .ts.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // `server-only` throws by design outside a React Server Component graph.
    // Jest runs plain Node, so map it to a no-op — the modules that import it
    // are still server modules, we just want to be able to unit test them.
    '^server-only$': '<rootDir>/tests/__mocks__/server-only.js',
    '^@/(.*)$': '<rootDir>/$1',
  },
  collectCoverageFrom: [
    'lib/**/*.{js,jsx,ts,tsx}',
    'app/api/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/.next/**',
  ],
  testMatch: [
    '**/__tests__/**/*.{js,jsx,ts,tsx}',
    '**/*.{spec,test}.{js,jsx,ts,tsx}',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.next/',
    '/workspace/',           // Exclude generated workspace tests
'/tests/e2e/',           // Exclude Playwright e2e tests
    'globals.d.ts',          // Exclude type definitions
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(bson|mongodb|openai)/)',
  ],
}

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig)

