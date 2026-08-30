import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'self-hosting',
  title: 'Self-hosting Backenly',
  metaDescription:
    'Run the whole platform yourself: the two processes, what the compose files actually start, the PostgreSQL setting the measured detectors depend on, the build ordering that breaks deploys, and what you take on by running it.',
  lane: 'mechanism',
  category: 'Operations',
  answers: 'What do I actually run, and what do I take on by running it?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'The repository is the whole platform — runtime, governance, and the complete self-healing engine, not a stripped community edition. The platform is Apache-2.0 and the client libraries are MIT. This is what running it involves, including the parts that are genuinely your problem afterwards.',
  sections: [
    {
      heading: 'What runs',
      blocks: [
        {
          kind: 'table',
          columns: ['Process', 'Port', 'Serves'],
          rows: [
            ['Next.js', '3000', 'The dashboard and the platform APIs'],
            ['Express runtime', '3001', 'The public end-user API at /api/v1/*, realtime, presence, broadcast'],
          ],
        },
        {
          kind: 'p',
          text: 'Both sit behind a reverse proxy that sends `/api/v1/*` to the runtime and everything else to Next. They share one PostgreSQL instance. In development `npm run dev` starts both together; in production `ecosystem.config.js` runs them under PM2 as `backenly-nextjs` and `backenly-runtime`.',
        },
        {
          kind: 'note',
          text: 'The compose files do not start the application. `docker-compose.dev.yml` brings up the dependencies — PostgreSQL 15 and Redis — and the root `docker-compose.yml` builds the API-tester worker container. You run the two Node processes yourself, with `npm run dev` or PM2.',
        },
      ],
    },
    {
      heading: 'First run',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          label: 'From a clean checkout',
          code: `git clone https://github.com/backenly/backenly.git
cd backenly
npm install

cp .env.example .env      # then set DATABASE_URL, JWT_SECRET, OPENAI_API_KEY

# PostgreSQL + Redis, matching the defaults already in .env.example
docker compose -f docker-compose.dev.yml up -d

npm run db:generate && npm run db:push
npm run db:seed           # seeds the billing plans

npm run dev               # dashboard :3000 · runtime :3001`,
        },
        {
          kind: 'p',
          text: 'Node 20 is what the Dockerfile and CI build against. Two variables are not optional: `JWT_SECRET` signs every platform session — generate one per deployment with `openssl rand -hex 32` — and `OPENAI_API_KEY` powers planning. The autonomy loop runs no model, so it does not consume that key; only planning and generation do.',
        },
      ],
    },
    {
      heading: 'The PostgreSQL setting that changes what you can detect',
      blocks: [
        {
          kind: 'p',
          text: '`pg_stat_statements` is the only source of measured query latency in the platform. Without it, Backenly can find missing indexes by shape — this column is a foreign key — but not by measurement, where Postgres is actually spending time filtering. It needs `shared_preload_libraries`, which needs a server restart, which is why it is set at the server rather than in a migration.',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'postgresql.conf, then restart',
          code: `shared_preload_libraries = 'pg_stat_statements'`,
        },
        {
          kind: 'code',
          language: 'sql',
          label: 'Then, per database',
          code: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`,
        },
        {
          kind: 'p',
          text: '`docker-compose.dev.yml` preloads the library and `docker/postgres-init/` creates the extension for you on a fresh data directory. On a volume that already exists, run the statements by hand — extensions are per-database, not per-cluster.',
        },
        {
          kind: 'p',
          text: 'On a database without it, the measured slow-query invariant reports UNCHECKED rather than satisfied. That distinction is deliberate: an empty result from a probe whose data source does not exist is indistinguishable from a healthy backend, and treating the two the same is how a detector once read green while it was dead.',
        },
      ],
    },
    {
      heading: 'Deploying an update',
      blocks: [
        {
          kind: 'p',
          text: '`scripts/deploy.sh` is the single entry point. It pulls, syncs the Prisma schema when `prisma/schema.prisma` changed in the pulled range, builds, restarts only after the post-build step completes, and health-checks. Prefer it over running the steps by hand — the ordering constraints are the part people get wrong.',
        },
        {
          kind: 'list',
          items: [
            'Never restart before `npm run build` has finished, including `postbuild`. That step copies static assets into the standalone output; restarting early serves a build with no CSS or JavaScript.',
            'Run `npm run db:generate` after any `schema.prisma` change, before the build. A stale Prisma client fails at runtime, not at build time.',
            'Pass `--update-env` when restarting under PM2 if `.env` changed, or the process keeps its old environment.',
          ],
        },
        {
          kind: 'p',
          text: 'The build itself carries gates before `next build` runs: a v1 parity check and an assertion that nothing writes API-definition rows. They fail the build rather than shipping a divergence, so a red build here is usually telling you something true.',
        },
      ],
    },
    {
      heading: 'What you take on',
      blocks: [
        {
          kind: 'responsibility',
          platform: [
            'Ships the complete engine — governance, verification, and the autonomy loop — under Apache-2.0.',
            'Keeps clients MIT, so the SDK, CLI, and MCP server impose nothing on what embeds them.',
            'Reports a probe it cannot run as UNCHECKED rather than passing.',
            'Moves data in either direction between self-hosted and Cloud with pg_dump.',
          ],
          you: [
            'The servers, the PostgreSQL instance, backups, and TLS.',
            'Your own OpenAI key, and the cost of planning and generation on it.',
            'Upgrades, and the schema sync that goes with them.',
            'Reverse-proxy configuration, and keeping the two processes supervised so a crash restarts.',
          ],
        },
        {
          kind: 'p',
          text: 'Supervision is worth calling out specifically. The runtime process serves every end-user API call, so if it dies unsupervised, every `/api/v1/*` request for every project fails until someone notices. Run it under something that restarts it — PM2 with `autorestart`, or a systemd unit with `Restart=always`.',
        },
        {
          kind: 'p',
          text: 'Backenly Cloud runs this same codebase and takes the infrastructure, backups, upgrades, and the planning tokens. Self-hosting is free and complete; the trade is operational work, not features.',
        },
      ],
    },
    {
      heading: 'Contributing',
      blocks: [
        {
          kind: 'p',
          text: 'Pull requests are open. Two things are worth knowing before you write code: tests run against a real PostgreSQL instance and the database is never mocked, because mocking it has caused production incidents here before. And every schema mutation goes through the governed kernel — a patch that writes DDL around it will be sent back regardless of how correct the SQL is.',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'Before opening a PR',
          code: `npm run lint
npx tsc --noEmit
npm test
npx tsx scripts/preflight-oss.ts --tree   # no credentials in what you committed`,
        },
      ],
    },
  ],
  conclusion:
    'Two Node processes, one PostgreSQL, and a reverse proxy in front. Preload `pg_stat_statements` if you want the measured detectors rather than only the structural ones, use the deploy script so the build finishes before the restart, and supervise the runtime process. Everything the hosted product runs is in the repository.',
  relatedSlugs: ['how-backenly-works', 'after-you-launch'],
}
