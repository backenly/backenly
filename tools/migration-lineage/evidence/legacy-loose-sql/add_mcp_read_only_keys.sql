-- Read-only MCP keys.
--
-- `scope='mcp'` was all-or-nothing, so "let an agent explore production" and
-- "let an agent rewrite production" were the same credential. This splits them
-- at issuance, which is the only point where a human is actually in the loop.
--
-- Every existing row defaults to false: an MCP key that worked yesterday keeps
-- exactly the power it had. The mode is opt-in at mint time and there is no
-- endpoint that flips it on an existing key — changing a key's power means
-- minting a new one, so the audit trail records a decision rather than a drift.
--
-- Enforcement is layered, and only the last one is a security boundary:
-- tools/list hides the mutating tools, /api/mcp/* refuses them with
-- READ_ONLY_KEY, and run_query already runs as the project's SELECT-only
-- `bkn_ro_<hex>` Postgres role. A parser is never the boundary.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "mcpReadOnly" BOOLEAN NOT NULL DEFAULT false;
