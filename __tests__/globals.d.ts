/// <reference types="jest" />
/// <reference types="@testing-library/jest-dom" />

// Extend global namespace for test mocks
declare global {
  var Request: typeof globalThis.Request
  var Response: typeof globalThis.Response
  var Headers: typeof globalThis.Headers
}

export {}
