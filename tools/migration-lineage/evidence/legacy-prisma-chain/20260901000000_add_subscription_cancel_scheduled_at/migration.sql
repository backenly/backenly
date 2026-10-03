-- Voluntary cancellation is not a payment failure.
--
-- Both used to land in graceUntil, which meant a customer who cancelled on day
-- 1 of a 30-day period lost access on day 8 -- 22 days they had already paid
-- for. graceUntil now means failed-payment recovery and nothing else, and this
-- column mirrors the provider's scheduled cancellation date instead.
--
-- Additive and nullable with no default, so the column is simply absent from
-- every row until Paddle supplies a date. There is no backfill: a value here
-- must always be a date Paddle reported, never one this codebase computed.
-- Entitlement resolution does not read it, so a release that does not know
-- about the column behaves exactly as it does today.

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancelScheduledAt" TIMESTAMP(3);
