-- Exact-call approvals.
--
-- An MCP domain tool that is asked for a destructive or high-risk action parks
-- the exact tool and arguments for a human, and runs them verbatim once
-- approved, with no model involved. Requests raised by backend_chat leave this
-- NULL and keep replaying their message through the brain, as before.
--
-- Nullable and additive: existing rows and code that does not know the column
-- are unaffected.

ALTER TABLE "agent_approval_requests" ADD COLUMN "toolArgs" JSONB;
