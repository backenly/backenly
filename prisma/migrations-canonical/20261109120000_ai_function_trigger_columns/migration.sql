-- Row-update functions: the columns they watch. A function fired by row
-- updates runs only when one of these columns changed; without a row it runs
-- on every update, as before.
--
-- A table of its own rather than a column on "ai_functions": every read of a
-- function loads its whole row, so a column there would break those reads for
-- as long as a release ran ahead of this migration. Without this table,
-- functions run on every update, as they did.
--
-- Additive: no existing table, column or row changes.

-- CreateTable
CREATE TABLE "ai_function_trigger_columns" (
    "functionId" TEXT NOT NULL,
    "columns" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_function_trigger_columns_pkey" PRIMARY KEY ("functionId")
);

-- AddForeignKey
ALTER TABLE "ai_function_trigger_columns" ADD CONSTRAINT "ai_function_trigger_columns_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "ai_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
