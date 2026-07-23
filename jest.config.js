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

