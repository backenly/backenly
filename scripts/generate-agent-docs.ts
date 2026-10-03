/**
 * Rewrite the generated blocks in public/llms.txt and public/docs/agents/*.md
 * from lib/mcp/domains.ts. Run after changing a section tool's actions:
 *
 *   npx tsx scripts/generate-agent-docs.ts
 *
 * tests/unit/agent-docs-conformance.spec.ts fails until the output is committed.
 */

import fs from 'fs'
import path from 'path'
import { generatedBlocks, replaceGeneratedBlock } from '../lib/mcp/agent-docs-render'

const PUBLIC = path.join(process.cwd(), 'public')
let changed = 0
for (const block of generatedBlocks()) {
  const file = path.join(PUBLIC, block.file)
  const before = fs.readFileSync(file, 'utf8')
  const after = replaceGeneratedBlock(before, block.name, block.content)
  if (after !== before) {
    fs.writeFileSync(file, after)
    changed++
    console.log(`updated ${block.file} (${block.name})`)
  }
}
console.log(changed ? `${changed} block(s) updated` : 'agent docs are up to date')
