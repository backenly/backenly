# How to file a bug we can act on

> **Security issues do not go here.** Email **support@backenly.com** with `SECURITY` in the subject. A public report is a working exploit handed to everyone running this software before any of them can patch it. Acknowledgement within 72 hours, assessment within 7 days. See [SECURITY.md](https://github.com/backenly/backenly/blob/main/SECURITY.md).

A [GitHub issue](https://github.com/backenly/backenly/issues) is still the canonical place for a confirmed bug. This forum is where we work out whether it is one — faster, and without a half-formed issue sitting in the tracker forever.

## The shape of a useful report

**Version.** Commit or tag. `git rev-parse --short HEAD` if you're on a clone.

**Environment.** OS, Node version, Docker version. Bundled Compose stack, or your own PostgreSQL and PostgREST?

**Steps to reproduce.** Numbered, from a clean-ish state. If it only reproduces with specific data, say what's specific about it.

**Expected vs actual.** Separately.

**Logs.** The relevant lines from the web app and the runtime, plus PostgreSQL if the failure is at the data layer. Trim to what's relevant, but don't trim the stack trace.

<!-- split -->

## Redact first

`.env`, connection strings, `BACKENLY_SETUP_TOKEN`, API keys, JWTs — in text and in screenshots. Rotate anything you post by accident.

## Tags

Post with `Needs triage`. We move it to `Confirmed`, `Fixed`, or `Not a bug`. Add a surface tag — `Install`, `Autonomy`, `MCP` — if one fits; it helps the right person find it.

## Two things that aren't bugs

**Destructive changes waiting for approval.** Dropping a column, changing auth, touching external credentials — the autonomy loop heals only the reversible safe band and stops on anything else. That's the design.

**`npm run bootstrap` needing a second run.** It's a reconciler, not an installer. Running it twice is the intended path.

-# If it turns out to be real and you want to fix it yourself, say so in the thread — we'll leave it to you and help if you want it.
