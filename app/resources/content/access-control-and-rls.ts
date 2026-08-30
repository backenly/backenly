import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'access-control-and-rls',
  title: 'Access control and row-level security',
  metaDescription:
    'How authorization works on Backenly: Postgres grants and row-level security instead of application filtering, a deterministic set_rls door that installs your predicate verbatim, the named policy templates, and the behavioural isolation check.',
  lane: 'mechanism',
  category: 'Security',
  answers: 'Who can read which rows, and how do I know the rule actually holds?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'This is the page where being wrong is a vulnerability rather than a bug, so it is worth reading before you have users. Two things carry the weight: authorization lives in PostgreSQL rather than in your code, and the predicate you write is the predicate that gets installed — never a model\'s paraphrase of it.',
  sections: [
    {
      heading: 'Isolation is a grant, not a filter',
      blocks: [
        {
          kind: 'p',
          text: 'Each project gets its own PostgreSQL schema, and cross-project isolation is enforced by Postgres privileges. A request for another tenant\'s data fails on a missing grant, not on a `WHERE` clause somebody remembered to add. The read-only SQL door runs as a SELECT-only role inside a read-only transaction, so it cannot write and cannot reach another tenant\'s data even with a hand-written query.',
        },
        {
          kind: 'p',
          text: 'Within a project, row-level security decides which rows an end-user sees. Policies read the calling user through `backenly_jwt_claim(\'sub\')`, which resolves to the subject of the `X-User-Token` on the request. Because the rule is in the database, the same answer comes back through the v1 contract, the v2 grammar, an embedded resource, and the SDK. You never write "filter by current user" in a component, which means you cannot forget it on one screen.',
        },
        {
          kind: 'note',
          text: 'A request with no `X-User-Token` runs unauthenticated and an RLS-protected table returns zero rows rather than an error. That is the policy filtering, working correctly — but it makes a missing header look identical to an empty table. Check the header first when a list is unexpectedly empty.',
        },
      ],
    },
    {
      heading: 'Writing a policy: the deterministic door',
      blocks: [
        {
          kind: 'p',
          text: '`set_rls` takes SQL, one rule per command. Your predicates are installed verbatim, and the policies are read back from `pg_policies` before the tool reports success. No model is involved, so it is idempotent and cannot be rate-limited by an inference provider.',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'A four-command policy',
          code: `set_rls {
  tableName: "profiles",
  select: { using: "(is_public AND NOT is_flagged) OR user_id::text = backenly_jwt_claim('sub')" },
  insert: { check: "user_id::text = backenly_jwt_claim('sub')" },
  update: { using: "user_id::text = backenly_jwt_claim('sub')",
            check: "user_id::text = backenly_jwt_claim('sub')" },
  delete: { using: "user_id::text = backenly_jwt_claim('sub')" }
}`,
        },
        {
          kind: 'p',
          text: '`using` is which rows a command may target; `check` is which rows it may write. The two differ on `UPDATE`, which is where most hand-written policies go wrong: a rule that lets you target your own row but does not check what you write lets a user reassign ownership to themselves.',
        },
        {
          kind: 'p',
          text: 'Naming only some commands scopes the edit — pass `update` and `delete` and the `select` and `insert` rules are left byte-identical. Predicates can reach a parent row with `EXISTS`, which is how "participants may read, only the sender may edit" is expressed:',
        },
        {
          kind: 'code',
          language: 'sql',
          label: 'Reaching the parent row',
          code: `EXISTS (
  SELECT 1 FROM conversations p
  WHERE p.id = messages.conversation_id
    AND (p.user_a::text = backenly_jwt_claim('sub')
      OR p.user_b::text = backenly_jwt_claim('sub'))
)`,
        },
        {
          kind: 'p',
          text: 'This tool exists because the alternative was measurably worse. When RLS was reachable only by describing it to a language model, a request to change UPDATE and DELETE re-derived all four commands and reverted SELECT; `P AND sender_id = sub` came back as `P`, silently dropping the conjunct that restricted it; a cross-table `EXISTS` regressed to the owner-column form the model knew best. Each of those is a predicate re-generated from prose rather than applied as written, and none is fixable with a better prompt. Describe a policy to `backend_chat` only when you genuinely cannot write the predicate.',
        },
      ],
    },
    {
      heading: 'The named templates',
      blocks: [
        {
          kind: 'p',
          text: 'When a policy is a standard shape, `add_rls` installs it by name. It is dispatchable but not on the advertised 20-tool surface, so ask for it by name through `backend_chat`. It never substitutes a different policy for the one you asked for — an unrecognised template is refused with the real list.',
        },
        {
          kind: 'table',
          columns: ['Template', 'When it is right'],
          rows: [
            ['auto', 'Reads the columns and foreign keys and installs what the schema implies. Refuses with an explanation rather than guessing when ownership is ambiguous.'],
            ['owner_read_write', 'Exactly one user column — each user reads and writes only their own rows.'],
            ['participants', 'Two or more user columns: connections(requester_id, addressee_id), conversations(user_a, user_b), follows, matches, invitations.'],
            ['owned_via_parent', 'No user column of its own, but a foreign key to a user-owned table — line items, shipping addresses, messages in a conversation.'],
            ['public_read', 'Anyone reads, only the owner writes. Blogs, marketplaces.'],
            ['org_members', 'Multi-tenant B2B. Needs an organization_id column and enable_teams already run.'],
            ['admin_only', 'Server-side jobs only — reachable with a service-role key and nothing else.'],
            ['all_access', 'Every authenticated user reads and writes everything. Rare; use deliberately.'],
            ['custom', 'The escape hatch: your own predicate over this table\'s columns. Subqueries are refused here — use owned_via_parent when the rule has to read another table.'],
          ],
        },
        {
          kind: 'note',
          text: 'The most common wrong choice is `owner_read_write` on a two-party table. It grants access to one side and locks the other out of their own row — the conversation that only the sender can read. If a table has two user columns, it wants `participants`.',
        },
      ],
    },
    {
      heading: 'Proving the rule holds',
      blocks: [
        {
          kind: 'p',
          text: 'A policy that looks right and does not hold is the failure this whole surface exists to prevent, so the check is behavioural rather than textual. After a build, a second end-user is created, signed in, and used to read the first user\'s rows. The assertion is that they receive zero.',
        },
        {
          kind: 'steps',
          steps: [
            {
              label: 'Setup',
              title: 'Two real users through the real endpoint',
              body: 'Both are created through /auth/signup over live HTTP, not inserted directly.',
            },
            {
              label: 'Act',
              title: 'User A inserts a row',
              body: 'Through the generated API, carrying A\'s token.',
            },
            {
              label: 'Assert',
              title: 'User B reads and sees nothing',
              body: 'The check passes only on zero rows. A policy whose text looks correct but whose predicate is permissive fails here.',
            },
            {
              label: 'Report',
              title: 'The evidence, not a checkmark',
              body: 'The result carries its assertions into your agent\'s reply and the project journal. A check that could not run is reported skipped, and a skip is never counted as a pass.',
            },
          ],
        },
        {
          kind: 'p',
          text: 'The autonomy loop also carries an RLS detector, and undoing a policy is treated differently from other reverts: because removing a policy removes a protection, the undo takes a second explicit confirmation, enforced by the server rather than only by the button.',
        },
      ],
    },
    {
      heading: 'Keys and scopes',
      blocks: [
        {
          kind: 'p',
          text: 'Three credentials do three different jobs, and mixing them up is the other common mistake:',
        },
        {
          kind: 'table',
          columns: ['Credential', 'Identifies', 'Where it belongs'],
          rows: [
            ['Public anon key', 'The project, in a browser', 'Frontend code. The SDK can fetch it for you via the bootstrap handshake.'],
            ['End-user JWT (X-User-Token)', 'A person using your app', 'Set by the SDK after sign-in; read by every RLS policy.'],
            ['Scoped MCP key', 'An agent operating the project', 'Your MCP host config. Never in your repository.'],
          ],
        },
        {
          kind: 'p',
          text: 'MCP keys can be minted read-only, which serves a reduced manifest and refuses every write door — including `backend_chat` — with `READ_ONLY_KEY` before anything runs. An agent cannot upgrade its own key, and no endpoint flips an existing one; read-only is chosen by a human at mint time.',
        },
        {
          kind: 'responsibility',
          platform: [
            'Enforces tenant isolation with Postgres grants rather than application code.',
            'Installs your RLS predicate verbatim and reads pg_policies back before reporting success.',
            'Proves cross-user isolation behaviourally after a build and shows the evidence.',
            'Withholds destructive and write tools from read-only keys at the key scope.',
          ],
          you: [
            'Decide the access rule. The platform will not infer a policy you never stated.',
            'Check `using` versus `check` on UPDATE — that is where policies leak.',
            'Read the isolation check on any table holding private data.',
            'Revoke keys you stop using, and keep them out of version control.',
          ],
        },
      ],
    },
  ],
  conclusion:
    'Authorization is enforced by PostgreSQL, written as SQL you control, and proven by signing in as a second user and getting nothing back. When you can write the predicate, write it — the deterministic door exists because a re-derived policy can come back simplified in the permissive direction, and that class of mistake does not announce itself.',
  relatedSlugs: ['the-data-api', 'your-first-backend', 'after-you-launch'],
}
