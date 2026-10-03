# Backenly repository, Git, and AWS release workflow

This rule is durable operating policy for coding agents. Follow it in every
session before committing, pushing, or discussing a Backenly Cloud deployment.

## Establish context before changing Git

At the start of a write task, inspect:

```bash
git status --short
git branch --show-current
git remote -v
git fetch origin
```

Do not assume the checkout is on `main`, clean, attached to a branch, or even
the repository you intended. Never commit onto an unrelated in-flight branch
just because it is currently checked out.

## The three repositories have different jobs

- `backenly/backenly` — PUBLIC. Canonical source for Backenly OSS and all
  product/core code shared by Cloud. It must remain a complete, truthful OSS
  implementation.
- `backenly/backenly-cloud` — PRIVATE. Add-only Cloud overlay, the exact
  `PUBLIC_BASE_SHA` pin, Cloud-only providers/control-plane code, and immutable
  release records. It is not a fork and must not replace public files.
- `backenly/backenly-infra` — PRIVATE. Terraform for AWS staging and
  production. It is the infrastructure source of truth.

Do not copy private Cloud implementation or AWS infrastructure into the public
repository. Do not put general product/core fixes in the Cloud overlay merely
because the bug was found on backenly.com.

When a change affects public code that Cloud consumes:

1. commit and merge the public change;
2. use the resulting FULL public SHA;
3. update `backenly-cloud/PUBLIC_BASE_SHA` to that exact SHA;
4. commit/merge any corresponding Cloud overlay change;
5. verify composition against that exact pair.

If only the private overlay changes, the public pin does not move unless the
overlay actually requires a newer public commit.

Infrastructure changes belong only in `backenly-infra`. A normal application
release does not create an infrastructure branch unless Terraform source or
committed environment configuration itself must change.

## When to create a Git branch

A branch is for isolating a distinct change, not a ritual performed for every
prompt.

CREATE a new short-lived branch when:

- you are on protected `main` and need to change tracked files;
- the current branch contains a different concern or an unrelated open PR;
- the work is experimental or must pass CI/review before merge;
- Terraform source/configuration is changing;
- the change is large enough to need independent review.

REUSE the current branch when:

- it already represents the same coherent task/PR;
- the new edit is a direct fix or completion of that same change.

DO NOT create a new branch merely because:

- a new chat/session started;
- the edit is another file in the same existing task;
- you are only building, testing, planning Terraform, reading AWS, or promoting
  already-merged release artifacts.

For the public repository, `main` is protected and required checks matter:
changes should normally land through a short-lived branch + PR, even when the
code change is one line. A tiny change does not justify bypassing protected
main.

Example: a Product Hunt banner found while checked out on
`app-role-cutover` is an UNRELATED concern. Creating a clean marketing branch
from current `origin/main` is correct. If the banner were already part of an
open marketing branch/PR, creating another branch would be wrong.

Never deploy a feature branch to production. Merge first; releases are made
from recorded commits on the canonical branches.

Prefer names such as `fix/<topic>`, `feat/<topic>`, `docs/<topic>`, or
`chore/<topic>`. Delete merged short-lived branches.

## Commit and push discipline

- One coherent concern per commit. Do not mix unrelated cleanup.
- Review `git diff --check` and the staged diff before committing.
- Run the relevant tests/checks before declaring the commit ready.
- Do not add a `Co-Authored-By` trailer.
- Never commit secrets, state files, provider binaries, generated credentials,
  local project workspaces, backups, or environment files.
- Push the task branch, open/update the PR, and let required checks finish.
- Do not claim a change is deployed merely because it was pushed.
- Do not create a release record for an artifact that was built from an
  uncommitted or dirty tree.

If the checkout is dirty with unrelated work, preserve it. Use a separate
worktree or a clean branch from `origin/main`; never stash/reset/delete someone
else's work just to make the current task convenient.

### Verify the Git identity before any automated commit

Identity is configured **per repository** in `.git/config`, so a fresh clone, a
new worktree, or a different Backenly repo may not carry it:

```bash
git config user.name && git config user.email
```

Both must be the approved identity — `Adarsh` with the GitHub `noreply`
address. If they are not, set them at repo scope before committing rather than
committing under a wrong, personal, or machine-default identity. This
repository is public and the commit author is published.

## Backenly Cloud infrastructure facts

Backenly Cloud has completely moved to AWS.

- Production and staging run in AWS `ap-south-1`.
- Web, Runtime, and PostgREST run on ECS Fargate.
- Images are stored in ECR and deployed by immutable digest.
- PostgreSQL is RDS.
- Persistent workspace/backup volumes are EFS.
- Object storage is native AWS S3 using the ECS task role/provider chain.
- Secrets are in AWS Secrets Manager.
- ALB/ACM front the services.
- Terraform in `backenly-infra` is the deployment authority.

The old Hetzner production server is retired. For Backenly Cloud, NEVER suggest
or run SSH deploys, `git pull` on a production VM, PM2 production deploys, or
`scripts/deploy.sh`. That script may still exist for VM/self-host use; it is
not the Cloud production path.

Backblaze B2 is also retired from Backenly Cloud. Do not configure Cloud with
Backblaze endpoints, static S3 access keys, or the old B2 public URL. Cloud uses
native S3 through IAM. The OSS product may continue supporting generic
S3-compatible storage for self-hosters; do not delete that capability merely
because Backenly Cloud no longer uses Backblaze.

## AWS authentication

The deployment workstation uses AWS SSO. If the SSO session is expired, report
that exact blocker and ask the user to renew it. Do not invent static AWS keys,
copy credentials into files, or improvise another deployment route.

An expired SSO session is an authentication blocker, not evidence that AWS
deployment is unsupported.

## Cloud release sequence

A release begins only after the intended source is merged.

1. Freeze the full public SHA and full Cloud SHA.
2. Confirm `PUBLIC_BASE_SHA` equals the public SHA and compose that exact pair.
3. Require a clean composed working tree except for the deterministic overlay.
4. Build and push immutable ECR artifacts.
5. Deploy to staging with Terraform from a known merged infra SHA.
6. Apply migrations using the dedicated migration artifact/path.
7. Run critical staging qualification.
8. Review the production Terraform plan and reject unrelated infrastructure
   changes.
9. Promote the qualified release to production.
10. Run production smoke and write the immutable release record.

Current web exception: Next.js `NEXT_PUBLIC_*` values are compiled at build
time, so the web image is environment-specific today. Build staging and
production web images from the SAME source pair and record both digests plus
their non-secret build-input shapes. Runtime and migration artifacts are
environment-neutral and should be promoted unchanged when qualified.

Do not pretend the web digest was promoted when it was rebuilt for a different
origin. The release record must say exactly what happened.

Never use an image tag as deployment authority. Record and deploy
`sha256:<digest>`.

Before an application release, Terraform should describe the existing
environment with no unrelated drift. If a release plan proposes unrelated
infrastructure reconciliation, separate that reconciliation from the app
release.

## Release records

The authoritative deployment history lives in
`backenly-cloud/releases/*.yml`, not in whichever branch happens to be checked
out. Record full source SHAs, infra SHA, immutable image digests, migrations,
staging/production results, and rollback information.

A release record must be truthful about exceptions (for example,
environment-specific web digests). Never rewrite history to make the process
look cleaner than it was.

## API keys: NULL plaintext is the healthy state

Bulk API-key repair is **retired**. A `NULL` stored plaintext is the **secure**
state, not a broken one.

`scripts/repair-all-api-keys.ts` still selects `{ key: null }` as "needs
repair" and regenerates a plaintext for every match, so **running it now would
rotate valid credentials.** It is operator-only with no HTTP surface. Retiring
or rewriting it is a tracked cleanup item — do not run it, and do not
reintroduce a bulk repair path reachable from the product.
