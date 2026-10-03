# Migration lineage evidence

**Evidence only. Never executable deployment history.**

These files are the exact bytes of a `prisma/migrations/` directory that exists
only in a local working tree. That path is gitignored, has no reachable git
history, and is not Backenly's migration history. They are kept here so the
lineage investigation in `docs/managed-db-migration-findings.md` has a fixed,
hashed input instead of an untracked directory that can drift.

```
legacy-prisma-chain/   18 migration directories + migration_lock.toml
legacy-loose-sql/      6 loose .sql files that Prisma never reads
SHA256SUMS             sha256 of every file above
provenance.json        where they came from, how they were reviewed, per-file metadata
```

Rules:

- Do not move these into `prisma/migrations/`, and do not point `prisma migrate`
  at this directory. The chain builds 50 of the 119 tables in `schema.prisma`,
  and four of the loose files cannot apply to it.
- The only permitted execution is replay into a throwaway scratch database by
  the lineage probe, to observe what the files produce.
- Do not edit a file in place. Line endings are preserved on purpose
  (`.gitattributes`), and `tests/unit/migration-lineage-evidence.spec.ts` fails
  if any byte stops matching `SHA256SUMS`.
