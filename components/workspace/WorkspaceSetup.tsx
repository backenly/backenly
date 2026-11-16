'use client'

/**
 * The Overview of a project with nothing built yet: connect the agent, then
 * ask it to build, and what the backend will hold (project console decision
 * 10, 2026-11-16; "Your backend" added on the founder's call the same day).
 *
 *   todo-list  ○ Not published
 *
 *   Connect your coding agent
 *   ✳ Claude Code  ◩ Cursor  ◎ Codex  ⋀ Antigravity  Other         [Local|Remote]
 *   claude mcp add backenly -- npx -y @backenly/mcp-server --project … --key …
 *   Run it in a terminal, then start a new Claude Code session.    [Generate key]
 *   Destructive changes wait for your approval.  Setup guide
 *
 *   Then ask it to build
 *   Build the backend for a task tracker: projects, tasks with a status and a
 *   due date, and email sign-in. Only a task's owner can edit it.          Copy
 *
 *   Your backend   (BackendStrip 'intro': what each part holds, in one line;
 *                   the live Overview shows the same strip with numbers)
 *
 * The founder's own todo-list sat on the old version of this page for 19 days
 * with nothing built: a numbered stepper and four icon cards stood between the
 * page and the one command that starts everything. The command is now on the
 * page, with a real key one click away (AgentSetup), and it switches by itself
 * when the agent first calls: "Your agent" with its last call, then "Ask it to
 * build". The first table switches the page to the live Overview.
 *
 * Creating keys is ADMIN (POST /mcp/keys); everyone else is told who can, and
 * still gets the request to pass on. Nothing is fabricated: no table, route or
 * user appears here until the agent creates it.
 */

import { useState } from 'react'
import Link from 'next/link'
import { CopyButton, StatusGlyph } from '@/components/inspector/kit'
import { Panel, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { EDGE, FOCUS, R_PANEL, WELL } from '@/components/console/tokens'
import { Time } from '@/components/console/Time'
import { AgentMark, AgentSetup, AgentSetupSkeleton, SetupFootnote } from '@/components/connect/AgentSetup'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { BackendStrip } from './BackendStrip'

/** Concrete enough to show what one ask builds: tables, auth and a rule (approved in #531). */
export const FIRST_REQUEST =
  "Build the backend for a task tracker: projects, tasks with a status and a due date, and email sign-in. Only a task's owner can edit it."

/** The request to send, full width, one click to copy. Prose, so Geist. */
function RequestBlock() {
  return (
    <div className={`flex items-start gap-[12px] ${R_PANEL} border ${EDGE} ${WELL} py-[12px] pl-[16px] pr-[8px]`}>
      <p className="min-w-0 flex-1 py-[3px] text-[13.5px] leading-[21px] text-zinc-100 [text-wrap:pretty]">{FIRST_REQUEST}</p>
      <CopyButton value={FIRST_REQUEST} label="Copy" showLabel />
    </div>
  )
}

export function WorkspaceSetup({ projectId }: { projectId: string }) {
  const agent = useAgentConnection(projectId)
  const role = useProjectRole(projectId)
  // A passed Test connection counts as connected, but the person may not have
  // copied the command yet, and its key is not shown again: keep the setup up.
  const [tested, setTested] = useState(false)
  const base = `/app/projects/${projectId}`
  // A role that could not be read is not a "no": offer the setup, and a refusal says so in the server's words.
  const mayConnect = role.canAdminister || role.error

  // Both answers decide which page this is; until then, the setup's own shape.
  if (agent.status === 'loading' || (role.loading && !agent.connected)) {
    return (
      <div aria-busy="true" aria-label="Loading" className="space-y-[36px]">
        <Section id="setup-loading" title="Connect your coding agent">
          <AgentSetupSkeleton />
        </Section>
      </div>
    )
  }

  if (agent.connected && !tested) {
    return (
      <div className="space-y-[36px]">
        <Section
          id="setup-agent"
          title="Your agent"
          aside={
            <Link href={`${base}/connect`} className={`rounded-[4px] text-[13px] leading-[20px] text-zinc-400 transition-colors duration-150 hover:text-white ${FOCUS}`}>
              Connect
            </Link>
          }
        >
          <Panel>
            <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] px-[20px] py-[14px]">
              <span className="flex min-w-0 items-center gap-[10px]">
                <AgentMark label={agent.client} size={16} />
                <span className={ROW_TITLE}>{agent.client ?? 'Your agent'}</span>
                {/* Filled only while it is at work; a quiet agent is hollow (lib/mcp/agent-connection.ts). */}
                <StatusGlyph state={agent.active ? 'live' : 'idle'} label={agent.active ? 'Active' : 'Connected, quiet'} />
              </span>
              {agent.lastSeenAt && (
                <span className="text-[12.5px] leading-[18px] text-faint">
                  <Time iso={agent.lastSeenAt} prefix="Last call" />
                </span>
              )}
            </div>
          </Panel>
        </Section>
        <Section id="setup-ask" title="Ask it to build">
          <RequestBlock />
          <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">This page fills in as it builds.</p>
        </Section>
        <Section id="setup-backend" title="Your backend">
          <BackendStrip projectId={projectId} mode="intro" />
        </Section>
      </div>
    )
  }

  return (
    <div className="space-y-[36px]">
      <Section id="setup-connect" title="Connect your coding agent">
        {mayConnect ? (
          <AgentSetup projectId={projectId} onTested={() => setTested(true)} />
        ) : (
          <Panel>
            <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">
              Only an owner or admin can connect an agent to this project.
            </p>
          </Panel>
        )}
      </Section>
      <Section id="setup-ask" title={agent.connected ? 'Ask it to build' : 'Then ask it to build'}>
        <RequestBlock />
        {!mayConnect && <SetupFootnote className="mt-[10px]" />}
      </Section>
      <Section id="setup-backend" title="Your backend">
        <BackendStrip projectId={projectId} mode="intro" />
      </Section>
    </div>
  )
}
