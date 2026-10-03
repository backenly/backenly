/*
  Warnings:

  - A unique constraint covering the columns `[keyHash]` on the table `api_keys` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "keyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_keyHash_idx" ON "api_keys"("keyHash");
