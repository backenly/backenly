-- A bucket says who may upload into it.
--
-- Writing to storage through the public API needs a signed-in end user or a
-- service-role key. Which of them may upload into a given bucket was not
-- something a bucket could say, so every bucket took uploads from any
-- signed-in end user of its project. A bucket now says it: "signed_in" (any
-- signed-in end user of the project; each still changes only their own files)
-- or "server_only" (service-role keys, and the project's team from the
-- console).
--
-- Additive. The column is added with "signed_in", which is what every
-- existing bucket does today, so each keeps taking the uploads it takes now.
-- Then the default becomes "server_only", for buckets made from here on. The
-- application also states the value on every bucket it creates
-- (lib/storage/upload-access.ts): a bucket an upload creates, such as the
-- SDK's "default", takes "signed_in"; one made on purpose takes "server_only"
-- unless whoever makes it asks for "signed_in". The release that predates this
-- migration never reads the column, so it runs unchanged against it.

-- AlterTable
ALTER TABLE "storage_buckets" ADD COLUMN     "uploadPolicy" TEXT NOT NULL DEFAULT 'signed_in';

-- AlterTable
ALTER TABLE "storage_buckets" ALTER COLUMN "uploadPolicy" SET DEFAULT 'server_only';
