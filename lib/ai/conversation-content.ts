/**
 * A CONVERSATION'S WORDS, KEPT WHERE ITS PROJECT IS
 * =================================================
 * The agent's conversation about a project, and the summary rolled up from
 * it, are ConversationMessage rows in the platform database, which is in the
 * home region. Their words can quote the project's rows and its end users'
 * emails, so for a project kept in another region the words stay there: in
 * the region's public.regional_bodies (lib/data-plane/regional-bodies.ts,
 * kind conversation_message), under the row's id, for as long as the message
 * is kept. The platform row keeps the index the platform needs to order,
 * count and dedupe: role, metadata, times, sequence, and MESSAGE_KEPT_IN_REGION
 * in place of the words.
 *
 * A home project's messages are written and read exactly as before.
 *
 * Every writer and reader of the words goes through here. A region that
 * cannot be read is an error to the caller, never the platform row's marker
 * passed off as the conversation: the brain then works without its history,
 * and the summarizer skips rather than overwrite a summary with blanks.
 */

import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'

/** What a platform row holds in place of a regional project's message. */
export const MESSAGE_KEPT_IN_REGION = 'The message is kept in the project’s region.'

/**
 * Record one message. Its words go to the project's region first, under the id
 * the row then takes, so a row never exists without them.
 */
export async function createConversationMessage(input: {
  projectId: string
  role: string
  content: string
  metadata?: Prisma.InputJsonValue
}): Promise<{ id: string }> {
  const bodies = await regionalBodiesFor(input.projectId)
  const id = randomUUID()
  await bodies.set('conversation_message', id, { payload: { content: input.content } })
  return prisma.conversationMessage.create({
    data: {
      id,
      projectId: input.projectId,
      role: input.role,
      content: bodies.region ? MESSAGE_KEPT_IN_REGION : input.content,
      metadata: input.metadata ?? {},
    },
    select: { id: true },
  })
}

/**
 * Rows with their words: as they are for a home project, read from the
 * project's region otherwise. A row whose words the region does not have
 * reads as empty. Throws when the region cannot be read.
 */
export async function withMessageContents<T extends { id: string; content: string }>(
  projectId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows
  const bodies = await regionalBodiesFor(projectId)
  if (!bodies.region) return rows
  const kept = await bodies.getMany('conversation_message', rows.map((row) => row.id))
  return rows.map((row) => {
    const content = (kept.get(row.id)?.payload as { content?: unknown } | null | undefined)?.content
    return { ...row, content: typeof content === 'string' ? content : '' }
  })
}

/** Delete a project's messages that match `where`, and their words in its region with them. */
export async function deleteConversationMessages(
  projectId: string,
  where: Prisma.ConversationMessageWhereInput,
): Promise<number> {
  const doomed = (await prisma.conversationMessage.findMany({ where: { ...where, projectId }, select: { id: true } })).map(
    (row) => row.id,
  )
  if (doomed.length === 0) return 0
  // The words first: a row whose words are gone reads as empty, where words
  // whose row is gone would be kept with nothing pointing at them.
  await (await regionalBodiesFor(projectId)).remove('conversation_message', doomed)
  const { count } = await prisma.conversationMessage.deleteMany({ where: { id: { in: doomed }, projectId } })
  return count
}
