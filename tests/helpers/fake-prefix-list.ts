/**
 * A stand-in for EC2's managed prefix lists, for the direct Postgres allowlist
 * (lib/services/direct-access-allowlist.ts). No AWS call is ever made.
 *
 * It answers the three calls the sync makes with EC2's rules, as the API
 * reference states them: adding or removing entries creates a new version; a
 * modification that names a version other than the current one is refused
 * (PrefixListVersionMismatch, the code Terraform's AWS provider retries on); a
 * list still applying a modification refuses another (IncorrectState); at most
 * 100 entries are added and 100 removed per call; adding an entry already
 * there, or removing one that is not, is refused (InvalidPrefixListModification).
 *
 * Use from a test file:
 *
 *   jest.mock('@aws-sdk/client-ec2', () => jest.requireActual('../helpers/fake-prefix-list').mockEc2Module())
 *   import { prefixLists } from '../helpers/fake-prefix-list'
 */

export class AwsError extends Error {
  readonly $fault = 'client'
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

export class FakePrefixList {
  version = 1
  maxEntries = 1000
  /** Describes that still answer modify-in-progress after a modification. */
  settleDescribes = 0
  private inProgress = 0
  private readonly versions = new Map<number, Map<string, string>>([[1, new Map()]])
  /** Every call, in order: the command's name and input. */
  readonly calls: Array<{ command: string; input: any }> = []
  /** Error codes the next modifications throw, one each, before anything else. */
  failNext: string[] = []
  /** Run once just before the next modification is judged: a change made elsewhere. */
  beforeModify: (() => void) | null = null

  constructor(readonly id: string, readonly awsRegion: string) {}

  /** The entries now. */
  cidrs(): string[] {
    return [...this.versions.get(this.version)!.keys()].sort()
  }

  /** A change made outside Backenly (an operator, another process): a new version. */
  editElsewhere(add: string[], remove: string[] = []): void {
    const next = new Map(this.versions.get(this.version)!)
    for (const cidr of remove) next.delete(cidr)
    for (const cidr of add) next.set(cidr, 'added by hand')
    this.version += 1
    this.versions.set(this.version, next)
  }

  modifications(): Array<{ CurrentVersion: number; AddEntries?: Array<{ Cidr: string }>; RemoveEntries?: Array<{ Cidr: string }> }> {
    return this.calls.filter((c) => c.command === 'ModifyManagedPrefixListCommand').map((c) => c.input)
  }

  handle(command: string, input: any): any {
    this.calls.push({ command, input })
    switch (command) {
      case 'DescribeManagedPrefixListsCommand': {
        const state = this.inProgress > 0 ? 'modify-in-progress' : this.version > 1 ? 'modify-complete' : 'create-complete'
        if (this.inProgress > 0) this.inProgress -= 1
        return {
          PrefixLists: [
            { PrefixListId: this.id, AddressFamily: 'IPv4', State: state, Version: this.version, MaxEntries: this.maxEntries },
          ],
        }
      }
      case 'GetManagedPrefixListEntriesCommand': {
        const at = this.versions.get(input.TargetVersion ?? this.version)
        if (!at) throw new AwsError('InvalidParameterValue', `version ${input.TargetVersion} does not exist`)
        const all = [...at.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([Cidr, Description]) => ({ Cidr, Description }))
        const start = Number(input.NextToken ?? 0)
        const size = input.MaxResults ?? 100
        const page = all.slice(start, start + size)
        return { Entries: page, NextToken: start + size < all.length ? String(start + size) : undefined }
      }
      case 'ModifyManagedPrefixListCommand': {
        const fail = this.failNext.shift()
        if (fail) throw new AwsError(fail, `${fail} (injected)`)
        if (this.beforeModify) {
          const edit = this.beforeModify
          this.beforeModify = null
          edit()
        }
        if (this.inProgress > 0) throw new AwsError('IncorrectState', 'The prefix list is being modified.')
        if (input.CurrentVersion !== this.version) {
          throw new AwsError('PrefixListVersionMismatch', `The prefix list has the incorrect version number (${input.CurrentVersion}, not ${this.version}).`)
        }
        const add: Array<{ Cidr: string; Description?: string }> = input.AddEntries ?? []
        const remove: Array<{ Cidr: string }> = input.RemoveEntries ?? []
        if (add.length > 100 || remove.length > 100) throw new AwsError('InvalidParameterValue', 'At most 100 entries each way.')
        const next = new Map(this.versions.get(this.version)!)
        for (const { Cidr } of remove) {
          if (!next.has(Cidr)) throw new AwsError('InvalidPrefixListModification', `The entry ${Cidr} does not exist.`)
          next.delete(Cidr)
        }
        for (const { Cidr, Description } of add) {
          if (next.has(Cidr)) throw new AwsError('InvalidPrefixListModification', `The entry ${Cidr} already exists.`)
          next.set(Cidr, Description ?? '')
        }
        if (next.size > this.maxEntries) throw new AwsError('PrefixListMaxEntriesExceeded', 'The prefix list is full.')
        this.version += 1
        this.versions.set(this.version, next)
        this.inProgress = this.settleDescribes
        return { PrefixList: { PrefixListId: this.id, State: 'modify-in-progress', Version: this.version } }
      }
      default:
        throw new Error(`the fake EC2 has no answer for ${command}`)
    }
  }
}

/** The prefix lists the fake EC2 holds, by AWS region and id. */
export const prefixLists = {
  lists: new Map<string, FakePrefixList>(),
  /** The regions EC2 clients were made for, in order. */
  clientRegions: [] as string[],
  add(id: string, awsRegion: string): FakePrefixList {
    const list = new FakePrefixList(id, awsRegion)
    this.lists.set(`${awsRegion}/${id}`, list)
    return list
  },
  reset(): void {
    this.lists.clear()
    this.clientRegions.length = 0
  },
  send(awsRegion: string, command: { constructor: { name: string }; input: any }): any {
    const id = command.input?.PrefixListId ?? command.input?.PrefixListIds?.[0]
    const list = this.lists.get(`${awsRegion}/${id}`)
    if (!list) throw new AwsError('InvalidPrefixListID.NotFound', `The prefix list ID '${id}' does not exist in ${awsRegion}.`)
    return list.handle(command.constructor.name, command.input)
  },
}

/** @aws-sdk/client-ec2 with EC2Client answering from `prefixLists`; the command classes are the real ones. */
export function mockEc2Module() {
  const actual = jest.requireActual('@aws-sdk/client-ec2')
  class EC2Client {
    readonly region: string
    constructor(config: { region: string }) {
      this.region = config.region
      prefixLists.clientRegions.push(config.region)
    }
    async send(command: { constructor: { name: string }; input: any }) {
      return prefixLists.send(this.region, command)
    }
  }
  return { ...actual, EC2Client }
}
