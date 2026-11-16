/**
 * The end users Backenly's own checks sign up in a project, named by their
 * exact addresses.
 *
 * The contract probe (lib/services/contract-verifier.ts), the behavioral
 * verifier (lib/ai/behavioral-verifier.ts), run_test (lib/ai/brain/
 * verify-create.ts) and the build verifier (lib/ai/build-runtime/
 * behavioral-verifier.ts) sign up throwaway users to exercise sign-up, sign-in
 * and row-level security. Each uses a fixed prefix on a domain under
 * `.internal`, which is reserved for private networks.
 *
 * The match is on those exact shapes, never on the domain alone: a company's
 * own mail can be on a `.internal` domain, and its people are ordinary users.
 */

export const CHECK_ACCOUNT_PATTERN =
  '^(__(cv|http_bv|bv_test|bv_crud|bv_trg)_[a-z0-9_]+@(backenly|test)\\.internal' +
  '|(behavioral_test|behavioral_admin_test|behavioral_credits|rls_usera|rls_userb)_[0-9]+@backenly-test\\.internal)$'

const CHECK_ACCOUNT_RE = new RegExp(CHECK_ACCOUNT_PATTERN, 'i')

/** Whether `email` is the address of one of Backenly's own check accounts. */
export function isCheckAccountAddress(email: unknown): boolean {
  return typeof email === 'string' && CHECK_ACCOUNT_RE.test(email.trim())
}

/**
 * SQL that is true for a check account's row, matched on its `email` column the
 * same way. It carries no input, so it may be written into a WHERE clause.
 */
export const CHECK_ACCOUNT_SQL = `(email ~* '${CHECK_ACCOUNT_PATTERN}')`
