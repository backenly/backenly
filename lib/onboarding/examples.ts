/**
 * Onboarding Without Tutorials (Phase 16)
 * 
 * Self-explanatory examples that require no walkthrough.
 * The product teaches itself through language alone.
 */

export interface ExamplePlaceholder {
  context: 'main-screen' | 'project-name' | 'search' | 'filter'
  examples: string[]
  rotationMs?: number // Optional: rotate through examples
}

/**
 * Example-driven placeholder text for all inputs
 * NO tutorials, NO tours, NO docs—just examples
 */
export const ONBOARDING_EXAMPLES: Record<string, ExamplePlaceholder> = {
  // Main Screen ChatGPT-style prompt
  mainPrompt: {
    context: 'main-screen',
    examples: [
      "Add Google sign-in",
      "Create a products table with name and price",
      "Let users upload profile pictures",
      "Send email when someone signs up",
      "Make it live",
    ],
    rotationMs: 3000, // Rotate every 3 seconds
  },

  // Project creation
  projectName: {
    context: 'project-name',
    examples: [
      "My Shop",
      "Team Dashboard",
      "Event Planner",
    ],
  },

  // Search/filter (if needed)
  search: {
    context: 'search',
    examples: [
      "Find user table",
      "Show recent changes",
    ],
  },
}

/**
 * Get rotating placeholder example
 */
export function getRotatingExample(
  examples: string[],
  intervalMs: number = 3000
): string {
  const index = Math.floor(Date.now() / intervalMs) % examples.length
  return examples[index]
}

/**
 * Get random example (for non-rotating contexts)
 */
export function getRandomExample(examples: string[]): string {
  return examples[Math.floor(Math.random() * examples.length)]
}

/**
 * ONBOARDING PRINCIPLES:
 * 
 * 1. NO tutorials or walkthroughs
 * 2. NO "Getting Started" guides
 * 3. NO tooltips explaining features
 * 4. NO documentation links in primary UI
 * 5. Examples in placeholders teach by showing, not telling
 * 
 * The product should be self-explanatory:
 * - Main Screen placeholder shows what you can say
 * - Examples demonstrate capabilities implicitly
 * - Success messages teach next steps naturally
 * 
 * If users need a tutorial, the product failed.
 */

/**
 * Success messages that naturally teach next steps
 */
export const TEACHING_CONFIRMATIONS: Record<string, string> = {
  tableCreated: "Table created. Users can now add data through your app.",
  authAdded: "Google sign-in added. Users can sign in now.",
  apiGenerated: "API created. Your app can read and write data.",
  storageEnabled: "File uploads enabled. Users can upload images.",
  deployed: "Live. Your app is running at [URL].",
}

/**
 * NO-NO's for onboarding:
 * 
 * ❌ "Welcome! Let's get you started with a quick tour..."
 * ❌ "Click here to learn how to use Backenly"
 * ❌ "New to Backenly? Watch our tutorial video"
 * ❌ "Step 1 of 5: Create your first project"
 * ❌ Badge numbers indicating steps remaining
 * 
 * ✅ Just a text box with example: "Add Google sign-in"
 * ✅ Placeholder rotates showing different capabilities
 * ✅ Success messages naturally suggest what's possible next
 */
