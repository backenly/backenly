-- Who wrote a function's stored code: 'generated' (Backenly's own model — the
-- self-heal pass may rewrite it from a runtime error) or 'agent' (deployed
-- verbatim through functions deploy_code, which promises the code is stored
-- exactly as written and is therefore never model-rewritten).
--
-- Without this fact the runtime self-healer rewrote agent-deployed modules
-- after any thrown run — including infrastructure errors — and the agent's
-- next read returned code it never wrote.
--
-- Additive: one new column with a default, no existing row or column touched,
-- so the release that predates this migration runs unchanged against it.
-- Backfill note: rows that predate the column read 'generated', which keeps
-- self-heal available to them; an agent redeploy marks its row 'agent'.

-- AlterTable
ALTER TABLE "ai_functions" ADD COLUMN "codeOrigin" TEXT NOT NULL DEFAULT 'generated';
