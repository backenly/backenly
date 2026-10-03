# Storage

Index: https://backenly.com/llms.txt

Buckets and files, with per-project quotas and content-type validation. A bucket is private unless it is made public. Self-hosters can use local disk or any S3-compatible provider.

## Actions

<!-- generated:actions:storage by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `storage { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `create_bucket` | a new bucket, private unless isPublic | `bucketName` | no | no |
| `set_public` | make a bucket public or private | `bucketName`, `isPublic` | no | no |
| `list_buckets` | every bucket with its visibility | nothing | yes | no |
| `list_files` | the files in one bucket | `bucketName` | yes | no |
| `signed_url` | a time-limited download link for one file | `bucketName`, `path` | yes | no |
| `delete_file` | remove one file | `bucketName`, `path` | no | waits for a human |
| `delete_bucket` | remove a bucket and everything in it | `bucketName` | no | waits for a human |
<!-- end generated -->

Uploads happen from the app, through the SDK (`backend.storage.upload(file)`) or the runtime API, not from an agent tool. `signed_url` gives a time-limited download link for one file in a private bucket. Deleting a file or a bucket waits for a human; a deleted bucket takes everything in it.
