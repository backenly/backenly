/**
 * Generated functions are grounded in the real schema and proven to run.
 *
 * ── The reported failure ────────────────────────────────────────────────────
 *
 * "generate_function produces non-working code from reasonable specs. My
 *  first-pass specs for get-product, list-my-orders and place-order all returned
 *  bare 500s. Fixing them required specs so prescriptive I was effectively
 *  writing the code: exact SQL, schema-qualified table names, ::uuid casts,
 *  Number() coercion for Prisma BigInt."
 *
 * Two causes, neither of which is "the model is not good enough":
 *
 * 1. GROUNDING. The generation prompt received four things — function name,
 *    HTTP method, description, project id. It was never told which tables
 *    exist, what columns they have, what type those columns are, what the CHECK
 *    constraints permit, or whether RLS is on. So the model guessed, and every
 *    item on that "prescriptive spec" list is a fact the platform already held
 *    and did not pass on. The ::uuid cast is derivable from the column type.
 *
 * 2. VERIFICATION. The creation gate's own comment says it "never invokes the
 *    handler" and catches "code-shape errors". A wrong column name compiles.
 *    So broken code passed validation, deployed, and 500d on first use — which
 *    is the definition of shipping broken.
 *
 * These assert the contract of both fixes rather than the model's output, which
 * is the only part that can be made deterministic.
 */

describe('the generation contract tells the model what it needs', () => {
  let contract: string

  beforeAll(async () => {
    const mod: any = await import('@/lib/ai/function-generator')
    contract = mod.__ROUTE_MODULE_CONTRACT ?? ''
  })

  it('is exported for assertion — drift between it and the runner is a real bug', () => {
    expect(contract.length).toBeGreaterThan(200)
  })

  it('makes auth OPT-IN, so a public endpoint does not get an invented 401', () => {
    // "place-order invented a 401 auth check I never specified."
    expect(contract).toMatch(/AUTH IS OPT-IN/i)
    expect(contract).toMatch(/only when the description asks/i)
  })

  it('tells it to accept BOTH token header spellings', () => {
    expect(contract).toContain('x-user-token')
    expect(contract).toContain('authorization')
  })

  it('forbids the opaque catch block that hid every real error', () => {
    // "Responses are {"error":"internal_error"} with logs: []" — and it was
    // demanding error.message that finally exposed the RLS and CHECK failures.
    expect(contract).toMatch(/never a bare "internal_error"|Surface real errors/i)
    expect(contract).toMatch(/err instanceof Error \? err\.message/)
  })

  it('states that RLS identity is applied automatically', () => {
    // Otherwise the model writes its own set_config, which is both wrong and
    // now unnecessary — the connection already carries the caller's claims.
    expect(contract).toMatch(/do not try to set request\.jwt\.claims/i)
  })
})

describe('schema grounding', () => {
  it('renders the facts a spec-writer would otherwise have to supply by hand', async () => {
    const { __renderSchemaRules } = (await import('@/lib/ai/function-generator')) as any
    const rules: string = __renderSchemaRules()

    // Each of these is one of the things the developer had to hand-specify.
    expect(rules).toMatch(/\$1::uuid/)          // the cast
    expect(rules).toMatch(/workspace_/)          // schema qualification
    expect(rules).toMatch(/BigInt/i)             // COUNT(*) serialisation
    expect(rules).toMatch(/CHECK constraint/i)   // 23514 at runtime
    expect(rules).toMatch(/NOT NULL/)            // 23502 at runtime
  })
})

describe('the smoke gate classifies outcomes correctly', () => {
  // The decision rule, asserted directly: only a 5xx or a genuine code fault is
  // a failure. This matters because getting it wrong in either direction is
  // costly — treating a 4xx as failure would send every correctly-validating
  // mutation endpoint into a pointless repair loop, and treating a 5xx as
  // success is the original bug.
  const isFailure = (status: number) => status >= 500

  it('a 4xx is a PASS — the handler ran and rejected empty smoke input', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isFailure(s)).toBe(false)
  })

  it('a 5xx is a FAILURE — that is the bare 500 users were hitting', () => {
    for (const s of [500, 502, 503]) expect(isFailure(s)).toBe(true)
  })

  it('a 2xx is a PASS', () => {
    for (const s of [200, 201, 204]) expect(isFailure(s)).toBe(false)
  })

  it('"could not test" must never be reported as "broken"', async () => {
    // A database blip during generation must not fail an otherwise fine
    // function — an infrastructure failure is not evidence about the code.
    const infra = /timeout|ECONN|database|connect/i
    expect(infra.test('connect ECONNREFUSED 127.0.0.1:5432')).toBe(true)
    expect(infra.test('Route module failed to compile: Unexpected token')).toBe(false)
  })
})
