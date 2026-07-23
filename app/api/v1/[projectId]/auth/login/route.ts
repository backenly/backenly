export const dynamic = 'force-dynamic'

// Alias: /auth/login → /auth/signin
// AI platforms (Lovable, Replit, Base44) generate /auth/login by convention.
// Re-exporting the POST handler means Next.js routes this path identically
// to /auth/signin without duplicating any logic.
export { POST } from '../signin/route'
