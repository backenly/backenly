# 🧱 Self-Hosted — start here

The same platform, Apache-2.0, on your own infrastructure. **One deployment is one project.**

## The install

```bash
git clone https://github.com/backenly/backenly.git
cd backenly
npm install
npm run selfhost
```

That is the whole install. It generates the secrets, starts the Compose stack, creates the tables, runs the superuser steps, issues the PostgREST credential, and reconciles until the deployment reports ready. Then:

```bash
npm run dev     # dashboard :3000 · runtime :3001
```

You need **Node 20+** and **Docker with Compose** on the host. Docker does not provide Node — the app, the scripts, and the CLI all run on the host. The installer needs one thing it can't generate for you: an `OPENAI_API_KEY` in `.env` for planning and the autonomy loop.

`npm run selfhost` is **safe to rerun**. It fills in what's missing and never rotates a secret that already exists, so a rerun can't sign out your sessions or break a running PostgREST.

<!-- split -->

## Then claim the deployment

The installer prints a setup token. The first account to present it at signup becomes the administrator and takes ownership of this deployment's single project in the same step. There is no second command.

The token is in `.env` as `BACKENLY_SETUP_TOKEN`. It gates the claim because a deployment is often reachable before its operator gets to it — an open port on a VPS, a preview environment, a colleague pointed at the wrong host — and without it the single administrator slot goes to whoever loads the page first. Once claimed, the token stops working whatever it is set to.

## The four credentials, and why

The install creates a separate PostgreSQL role per job rather than one that does everything:

| Role | Used by | Properties |
|---|---|---|
| `backenly_user` | install scripts only | `SUPERUSER`. Creates roles, installs event triggers. **Never in `DATABASE_URL`.** |
| `backenly_app` | web and runtime | **`NOSUPERUSER NOBYPASSRLS`**. Owns the platform tables and workspace schemas. |
| `backenly_authenticator` | PostgREST | `NOINHERIT`; can only switch into `anon` / `authenticated` / `service_role`. |
| `backenly_backup` | `pg_dump` only | `NOSUPERUSER BYPASSRLS`, with `CONNECT`, `USAGE`, `SELECT` and nothing else. |

`backenly_app` not being a superuser is the one that matters most. A superuser bypasses row-level security — including `FORCE ROW LEVEL SECURITY` — so an application running as one has its own policies applied only by convention. Ownership plus `FORCE` is what keeps DDL working while leaving RLS in force. **Don't collapse these into one role.**

<!-- split -->

## Things people trip over

**Don't hand-order the PostgREST install steps.** The sequence in the README exists because getting it wrong bricks the database. If a step fails, run that step again rather than skipping ahead — `npm run bootstrap` is a reconciler, so rerunning repairs what's missing and changes nothing else. You will run it at least twice, and that's the intended path.

**Redact before you paste.** `.env`, connection strings, the setup token, JWTs. A self-hosted deployment's secrets are yours to leak.

**Bringing your own Postgres or PostgREST?** Read *Bringing your own database* in the README first. The Compose stack pins PostgREST and preloads `pg_stat_statements` for a reason.

## Where to ask

🤖 **selfhost-help-agent** — agent-driven changes against your deployment. Include version, tool call, response, and the relevant web + runtime log lines.
🙋 **selfhost-help-human** — install, upgrade, Docker, Postgres, PostgREST, ops. Include your OS, Node version, and whether you're on the bundled Compose stack.
🐞 **file-a-bug** — reproducible defects. **Not security issues.**
🧰 **contributing** — working on the codebase itself.
🏷️ **releases** — tagged releases and upgrade notes.

-# Security issues go to support@backenly.com with SECURITY in the subject, never to a public channel. You get an acknowledgement within 72 hours.
