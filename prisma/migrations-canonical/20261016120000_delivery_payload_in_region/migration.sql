-- A webhook or trigger delivery's payload is the row that fired it. For a
-- project outside the home region it is kept in that region's own database
-- (public.regional_bodies, scripts/sql/regional-bodies.sql), and the platform
-- row records only what the platform needs to schedule, list and alert; its
-- payload is then NULL (lib/data-plane/regional-bodies.ts).
--
-- Additive: two NOT NULL constraints dropped, no row or other column touched.
-- Every existing row keeps its payload, and a home project's rows are written
-- exactly as before, so the release that predates this migration runs
-- unchanged against it. Only a regional project's rows are written with a NULL
-- payload, and no region is open until this ships.

-- AlterTable
ALTER TABLE "webhook_logs" ALTER COLUMN "payload" DROP NOT NULL;

-- AlterTable
ALTER TABLE "trigger_delivery_logs" ALTER COLUMN "payload" DROP NOT NULL;
