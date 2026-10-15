export type BrainDoor = 'mcp'

/** Whether the caller is an external coding agent subject to agent safeguards. */
export function isAgentDoor(door: BrainDoor | undefined): boolean {
  return door === 'mcp'
}

/** Render optional dashboard context without confusing the caller with a page. */
export function currentPageContext(surface: string | null | undefined): string {
  if (!surface) return ''
  return `USER'S CURRENT PAGE: ${surface} — deictic references ("this table", "this page", "why is this failing") likely point at what that section shows. Use it to resolve ambiguity; never refuse because a name was omitted when the page implies it.\n`
}
