// Preloaded with `node --require` in front of a launcher. Replaces the `aws`
// binary with canned responses and records every call, so a launcher's full
// AWS conversation can be compared without credentials or network.
//
//   SHIM_SCENARIO  JSON: { "<service> <operation>": response }
//   SHIM_LOG       file that receives one JSON line per aws call
//
// A response is a plain object returned as JSON, or one of:
//   { __throw: "message" }          the call fails
//   { __byNextToken: { "": r, "f/1": r } }
//                                   chosen by the --next-token argument ("" when
//                                   absent), the way get-log-events pages
//   { __byAttempt: [r, r, ...] }    chosen by how many times the operation has
//                                   been called WITHOUT --next-token, i.e. how
//                                   many times a stream was read from its head.
//                                   The last entry repeats.

const cp = require('node:child_process')
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')

const scenario = JSON.parse(process.env.SHIM_SCENARIO || '{}')
const LOG = process.env.SHIM_LOG
const original = cp.execFileSync
const headReads = {}

cp.execFileSync = function execFileSyncShim(file, args, options) {
  if (file !== 'aws') return original.apply(this, arguments)
  fs.appendFileSync(LOG, JSON.stringify({ args }) + '\n')

  const op = `${args[0]} ${args[1]}`
  const tokenAt = args.indexOf('--next-token')
  const token = tokenAt >= 0 ? args[tokenAt + 1] : ''
  if (!token) headReads[op] = (headReads[op] || 0) + 1

  let response = scenario[op]
  if (response && Array.isArray(response.__byAttempt)) {
    const seq = response.__byAttempt
    response = seq[Math.min(headReads[op] || 1, seq.length) - 1]
  }
  if (response && response.__byNextToken) response = response.__byNextToken[token]
  if (response && typeof response.__throw === 'string') throw new Error(response.__throw)
  if (response === undefined || response === null) {
    return options && options.stdio === 'inherit' ? null : ''
  }
  return JSON.stringify(response)
}

// ESM named imports of builtins are snapshotted; this refreshes them.
syncBuiltinESMExports()
