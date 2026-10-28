import { currentPageContext, isAgentDoor } from '@/lib/ai/brain/input-context'

describe('brain caller and page context', () => {
  it('marks the MCP door as an agent without inventing a current page', () => {
    expect(isAgentDoor('mcp')).toBe(true)
    expect(currentPageContext(undefined)).toBe('')
    expect(currentPageContext(null)).not.toContain("USER'S CURRENT PAGE")
  })

  it('keeps real dashboard pages available for deictic references', () => {
    expect(currentPageContext('Database')).toContain("USER'S CURRENT PAGE: Database")
  })
})
