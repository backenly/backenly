/*
  Warnings:

  - You are about to drop the column `key` on the `api_keys` table. All the data in the column will be lost.
  - Made the column `keyHash` on table `api_keys` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "api_keys_key_key";

-- AlterTable
ALTER TABLE "api_keys" DROP COLUMN "key",
ALTER COLUMN "keyHash" SET NOT NULL;
