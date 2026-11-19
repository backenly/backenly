/**
 * THE IMPORT SANDBOX — where every read of a source happens on Backenly Cloud
 * ==========================================================================
 *
 * A source is someone else's server. What it answers is parsed by client code
 * that can be made to hold memory, hold threads or hang, so it is never read
 * in the website's process. Each look (the Review step) and each import runs in
 * a Fargate task of its own (lib/import/worker/main.ts):
 *
 *   - in a network of its own: public subnets of a VPC with no peering and no
 *     endpoints, reaching only the internet, on 443 and 5432 (backenly-infra,
 *     import-sandbox.tf), so a task can reach nothing of Backenly's but the
 *     public site;
 *   - with no role, no secret and no database URL: its job's id, a token for
 *     that job (only its SHA-256 is stored), and the origin to call back;
 *   - from the web task's own image, under a task definition the web registers
 *     from that image, so the task speaks the control plane's protocol;
 *   - stopped by the control plane when the person cancels, when its deadline
 *     passes, or when it stops reporting (lib/import/jobs.ts).
 *
 * The source's connection is sealed (AES-256-GCM, lib/security/projectEnvCrypto)
 * in the job's row while the job runs, handed to its task once, and wiped when
 * the job ends.
 *
 * Settings (backenly-infra puts them on the home web task while the sandbox is on):
 *   IMPORT_SANDBOX_CLUSTER, IMPORT_SANDBOX_FAMILY, IMPORT_SANDBOX_SUBNETS,
 *   IMPORT_SANDBOX_SECURITY_GROUP, IMPORT_SANDBOX_EXECUTION_ROLE_ARN,
 *   IMPORT_SANDBOX_LOG_GROUP, IMPORT_SANDBOX_ORIGIN
 * and optionally IMPORT_SANDBOX_CPU (1024) and IMPORT_SANDBOX_MEMORY (2048).
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { ImportConnection } from './contract'
import type { WorkerKind } from './worker/protocol'

export interface SandboxConfig {
  cluster: string
  family: string
  subnets: string[]
  securityGroup: string
  executionRoleArn: string
  logGroup: string
  /** Where the task calls back: the environment's public origin, https only. */
  origin: string
  region: string
  cpu: string
  memory: string
}

type Env = Readonly<Record<string, string | undefined>>

/** The sandbox's settings, or null when any is missing or malformed: then no source is read here at all. */
export function sandboxConfig(env: Env = process.env): SandboxConfig | null {
  const v = (name: string) => env[name]?.trim() ?? ''
  const subnets = v('IMPORT_SANDBOX_SUBNETS').split(',').map((s) => s.trim()).filter(Boolean)
  const cfg: SandboxConfig = {
    cluster: v('IMPORT_SANDBOX_CLUSTER'),
    family: v('IMPORT_SANDBOX_FAMILY'),
    subnets,
    securityGroup: v('IMPORT_SANDBOX_SECURITY_GROUP'),
    executionRoleArn: v('IMPORT_SANDBOX_EXECUTION_ROLE_ARN'),
    logGroup: v('IMPORT_SANDBOX_LOG_GROUP'),
    origin: v('IMPORT_SANDBOX_ORIGIN'),
    region: v('AWS_REGION') || v('AWS_DEFAULT_REGION'),
    cpu: v('IMPORT_SANDBOX_CPU') || '1024',
    memory: v('IMPORT_SANDBOX_MEMORY') || '2048',
  }
  const ok =
    cfg.cluster &&
    /^[A-Za-z0-9_-]{1,255}$/.test(cfg.family) &&
    subnets.length > 0 &&
    subnets.every((s) => /^subnet-[0-9a-f]+$/.test(s)) &&
    /^sg-[0-9a-f]+$/.test(cfg.securityGroup) &&
    /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(cfg.executionRoleArn) &&
    cfg.logGroup &&
    /^https:\/\/[a-z0-9.-]+$/i.test(cfg.origin) &&
    cfg.region &&
    /^\d+$/.test(cfg.cpu) &&
    /^\d+$/.test(cfg.memory)
  return ok ? cfg : null
}

// ── The job token ─────────────────────────────────────────────────────────────

/** A token for one job: given to its task, stored only as its SHA-256. */
export function newJobToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: tokenHash(token) }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Whether `token` is the one whose hash the job holds, compared in constant time. */
export function tokenMatches(token: string | null | undefined, hash: string | null | undefined): boolean {
  if (typeof token !== 'string' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false
  const a = Buffer.from(tokenHash(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── The connection, at rest while the job runs ───────────────────────────────

export interface SealedConnection {
  valueCipher: string
  valueIv: string
  valueTag: string
}

export async function sealConnection(connection: ImportConnection): Promise<SealedConnection> {
  const { encryptValue } = await import('@/lib/security/projectEnvCrypto')
  return encryptValue(JSON.stringify(connection))
}

export async function unsealConnection(sealed: SealedConnection): Promise<ImportConnection> {
  const { decryptValue } = await import('@/lib/security/projectEnvCrypto')
  return JSON.parse(decryptValue(sealed)) as ImportConnection
}

// ── Launching ─────────────────────────────────────────────────────────────────

export interface LaunchInput {
  jobId: string
  kind: WorkerKind
  token: string
}

export interface SandboxLauncher {
  /** Start the job's task; its ARN, when it has one. Throws when no task could be started. */
  launch(input: LaunchInput): Promise<{ taskArn: string | null }>
  /** Stop the job's task, if it still runs. Never throws. */
  stop(taskArn: string, reason: string): Promise<void>
}

let testLauncher: SandboxLauncher | null = null

/** For the tests: a launcher that runs the task's code where the test wants it. */
export function setSandboxLauncherForTests(launcher: SandboxLauncher | null): void {
  testLauncher = launcher
}

let ecs: { cfg: SandboxConfig; launcher: SandboxLauncher } | null = null

/** The launcher for this environment, or null when the sandbox is not set up here. */
export function sandboxLauncher(env: Env = process.env): SandboxLauncher | null {
  if (testLauncher) return testLauncher
  const cfg = sandboxConfig(env)
  if (!cfg) return null
  if (!ecs || JSON.stringify(ecs.cfg) !== JSON.stringify(cfg)) ecs = { cfg, launcher: ecsLauncher(cfg) }
  return ecs.launcher
}

/** The container the task definition names, and the path its entry point is bundled to (docker/web.Dockerfile). */
export const WORKER_CONTAINER = 'import-worker'
export const WORKER_ENTRY = '/opt/backenly-import/import-worker.cjs'

interface OwnImage {
  image: string
  runtimePlatform?: { cpuArchitecture?: string; operatingSystemFamily?: string }
}

/** This web task's own image, from the ECS task metadata endpoint, and its definition's platform. */
async function ownImage(client: import('@aws-sdk/client-ecs').ECSClient): Promise<OwnImage> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4
  if (!base) throw new Error('The import sandbox runs only from an ECS task: there is no task metadata here.')
  const container = (await (await fetch(base, { signal: AbortSignal.timeout(2_000) })).json()) as { Image?: unknown }
  const task = (await (await fetch(`${base}/task`, { signal: AbortSignal.timeout(2_000) })).json()) as { Family?: unknown; Revision?: unknown }
  if (typeof container.Image !== 'string' || !container.Image) throw new Error('The task metadata named no image.')
  let runtimePlatform: OwnImage['runtimePlatform']
  if (typeof task.Family === 'string' && task.Family && (typeof task.Revision === 'string' || typeof task.Revision === 'number')) {
    const { DescribeTaskDefinitionCommand } = await import('@aws-sdk/client-ecs')
    const own = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: `${task.Family}:${task.Revision}` }))
    runtimePlatform = own.taskDefinition?.runtimePlatform as OwnImage['runtimePlatform']
  }
  return { image: container.Image, runtimePlatform }
}

/** How much of the task's memory Node's heap may take, leaving the rest to buffers and the runtime. */
function heapMb(memory: string): number {
  return Math.max(256, Math.floor(Number(memory) * 0.6))
}

/** Whether the family's latest definition is exactly the one this web would register. */
function sameDefinition(td: any, want: OwnImage, cfg: SandboxConfig): boolean {
  const c = td?.containerDefinitions?.[0]
  return (
    !!c &&
    td.status === 'ACTIVE' &&
    !td.taskRoleArn &&
    td.executionRoleArn === cfg.executionRoleArn &&
    String(td.cpu) === cfg.cpu &&
    String(td.memory) === cfg.memory &&
    c.name === WORKER_CONTAINER &&
    c.image === want.image &&
    c.logConfiguration?.options?.['awslogs-group'] === cfg.logGroup &&
    JSON.stringify(c.command ?? []) === JSON.stringify([WORKER_ENTRY]) &&
    (want.runtimePlatform?.cpuArchitecture ?? null) === (td.runtimePlatform?.cpuArchitecture ?? null)
  )
}

export function ecsLauncher(cfg: SandboxConfig): SandboxLauncher {
  let clientPromise: Promise<import('@aws-sdk/client-ecs').ECSClient> | null = null
  const client = () =>
    (clientPromise ??= import('@aws-sdk/client-ecs').then(({ ECSClient }) => new ECSClient({ region: cfg.region })))
  let definition: { image: string; arn: string } | null = null

  async function taskDefinition(): Promise<string> {
    const ecsClient = await client()
    const want = await ownImage(ecsClient)
    if (definition && definition.image === want.image) return definition.arn
    const { DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand } = await import('@aws-sdk/client-ecs')
    const latest = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.family })).then(
      (r) => r.taskDefinition,
      () => undefined,
    )
    if (latest?.taskDefinitionArn && sameDefinition(latest, want, cfg)) {
      definition = { image: want.image, arn: latest.taskDefinitionArn }
      return definition.arn
    }
    const registered = await ecsClient.send(
      new RegisterTaskDefinitionCommand({
        family: cfg.family,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: cfg.cpu,
        memory: cfg.memory,
        executionRoleArn: cfg.executionRoleArn,
        // No taskRoleArn: the task can make no AWS call at all.
        ...(want.runtimePlatform ? { runtimePlatform: want.runtimePlatform as any } : {}),
        volumes: [{ name: 'tmp' }],
        containerDefinitions: [
          {
            name: WORKER_CONTAINER,
            image: want.image,
            essential: true,
            entryPoint: ['node'],
            command: [WORKER_ENTRY],
            user: 'node',
            readonlyRootFilesystem: true,
            mountPoints: [{ sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false }],
            environment: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'NODE_OPTIONS', value: `--max-old-space-size=${heapMb(cfg.memory)}` },
            ],
            linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
            stopTimeout: 10,
            logConfiguration: {
              logDriver: 'awslogs',
              options: { 'awslogs-group': cfg.logGroup, 'awslogs-region': cfg.region, 'awslogs-stream-prefix': 'import' },
            },
          },
        ],
      }),
    )
    const arn = registered.taskDefinition?.taskDefinitionArn
    if (!arn) throw new Error('Registering the import sandbox task definition returned no ARN.')
    definition = { image: want.image, arn }
    return arn
  }

  return {
    async launch({ jobId, token }) {
      const { RunTaskCommand } = await import('@aws-sdk/client-ecs')
      const arn = await taskDefinition()
      const out = await (await client()).send(
        new RunTaskCommand({
          cluster: cfg.cluster,
          taskDefinition: arn,
          launchType: 'FARGATE',
          count: 1,
          // The job, for whoever lists the cluster's tasks; a uuid fits the 36 characters allowed.
          startedBy: jobId.slice(0, 36),
          networkConfiguration: {
            awsvpcConfiguration: { subnets: cfg.subnets, securityGroups: [cfg.securityGroup], assignPublicIp: 'ENABLED' },
          },
          overrides: {
            containerOverrides: [
              {
                name: WORKER_CONTAINER,
                environment: [
                  { name: 'IMPORT_ORIGIN', value: cfg.origin },
                  { name: 'IMPORT_JOB_ID', value: jobId },
                  { name: 'IMPORT_JOB_TOKEN', value: token },
                ],
              },
            ],
          },
        }),
      )
      const task = out.tasks?.[0]?.taskArn
      if (!task) {
        const why = out.failures?.map((f) => `${f.reason ?? 'failed'}${f.detail ? ` (${f.detail})` : ''}`).join('; ')
        throw new Error(`No import sandbox task started${why ? `: ${why}` : ''}.`)
      }
      return { taskArn: task }
    },

    async stop(taskArn, reason) {
      try {
        const { StopTaskCommand } = await import('@aws-sdk/client-ecs')
        await (await client()).send(new StopTaskCommand({ cluster: cfg.cluster, task: taskArn, reason: reason.slice(0, 255) }))
      } catch (err) {
        console.warn('[Import] could not stop a sandbox task:', (err as Error)?.name ?? 'error')
      }
    },
  }
}
