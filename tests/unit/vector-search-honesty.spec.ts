/**
 * Vector search says what is true: it refuses where nothing can embed, refuses
 * to compare vectors from two different models, and no surface claims rows are
 * embedded when they are written, because nothing does that.
 *
 * The model is the deployment's (EMBEDDING_PROVIDER); these run under OpenAI's,
 * and tests/unit/embeddings-on-bedrock.spec.ts runs them under Bedrock's.
 */

import fs from 'fs'
import path from 'path'
import { embeddingConfig, vectorConfigMismatch } from '@/lib/ai/embeddings'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const ROUTE = 'app/api/v1/[projectId]/db/[tableName]/vector-search/route.ts'

describe('the stored vectors and the deployment’s model must match', () => {
  const openai = embeddingConfig({ OPENAI_API_KEY: 'k' })
  const MODEL = 'text-embedding-3-small'

  it('matches the model in use', () => {
    expect(vectorConfigMismatch({ model: MODEL, dimensions: 1536 }, openai)).toBeNull()
  })

  it('treats a table enabled before the model was recorded as the original model', () => {
    expect(vectorConfigMismatch({}, openai)).toBeNull()
  })

  it.each([
    { model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 },
    { model: MODEL, dimensions: 512 },
  ])('refuses %o, naming both models', (recorded) => {
    const why = vectorConfigMismatch(recorded, openai)
    expect(why).toContain(recorded.model)
    expect(why).toContain(MODEL)
  })
})

describe('the search route', () => {
  const route = read(ROUTE)

  it('checks availability and the model before it embeds anything', () => {
    const embedAt = route.indexOf('await embedText(')
    expect(route.indexOf('embeddingAvailability()')).toBeGreaterThan(-1)
    expect(route.indexOf('embeddingAvailability()')).toBeLessThan(embedAt)
    expect(route.indexOf('vectorConfigMismatch(vs)')).toBeLessThan(embedAt)
  })

  it('hands the caller an embedding failure’s plain words, never the provider’s', () => {
    // A Bedrock refusal names the AWS account and role.
    const failure = route.slice(route.indexOf('await embedText('), route.indexOf("code: 'EMBED_FAILED'") + 120)
    expect(failure).toContain("code: 'EMBED_FAILED'")
    expect(failure).not.toMatch(/e\?\.message/)
    expect(failure).toMatch(/detail: e instanceof AiError \? e\.userMessage : undefined/)
  })
})

describe('enabling it', () => {
  const executor = read('lib/ai/minimal-executor.ts')
  const body = executor.slice(executor.indexOf('async function executeEnableVectorSearch('))

  it('is refused before any DDL where no embedding model is configured', () => {
    expect(body.indexOf('embeddingConfig()')).toBeGreaterThan(-1)
    expect(body.indexOf('embeddingConfig()')).toBeLessThan(body.indexOf('CREATE EXTENSION'))
  })

  it('sizes the column and records the model from the configuration', () => {
    expect(body).toContain('const DIMENSIONS = embedding.dimensions')
    expect(body).toContain('const MODEL = embedding.model')
    expect(body).toContain('vector(${DIMENSIONS})')
    expect(body).toMatch(/dimensions: DIMENSIONS,\s+model: MODEL,/)
  })

  it('reads an existing column’s size before it would add one', () => {
    // ADD COLUMN IF NOT EXISTS keeps a column of another size; recording the
    // configured model over it would claim vectors it cannot hold.
    expect(body.indexOf('atttypmod')).toBeGreaterThan(-1)
    expect(body.indexOf('atttypmod')).toBeLessThan(body.indexOf('ADD COLUMN IF NOT EXISTS'))
  })
})

describe('no surface claims rows are embedded on write', () => {
  it.each(['lib/ai/brain/tools.ts', 'lib/ai/brain/capabilities.ts', 'lib/ai/minimal-executor.ts', ROUTE])('%s', (rel) => {
    expect(read(rel)).not.toMatch(/auto-embed/i)
  })
})

describe('no agent-facing description names an embedding model the deployment may not use', () => {
  it.each(['lib/ai/brain/tools.ts', 'lib/ai/brain/capabilities.ts'])('%s', (rel) => {
    expect(read(rel)).not.toMatch(/text-embedding-3-small|OpenAI embeddings/)
  })
})
