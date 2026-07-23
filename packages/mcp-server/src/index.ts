/**
 * Public entry — re-exports for programmatic embedding.
 *
 * Most users run this package via `npx @backenly/mcp-server`. Library
 * embedders (e.g. another agentic framework wrapping Backenly) can import
 * `startServer` or `BackenlyClient` directly.
 */

export { startServer } from './server.js'
export { runInit } from './init.js'
export { loadConfig, DEFAULT_ENDPOINT, CONFIG_PATH } from './config.js'
export { BackenlyClient } from './http.js'
export type { Config } from './config.js'
