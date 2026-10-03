export const dynamic = 'force-dynamic'

// Alias: /auth/login → /auth/signin
// AI platforms (Lovable, Replit, Base44) generate /auth/login by convention.
// Re-exporting the POST handler means Next.js routes this path identically
// to /auth/signin without duplicating any logic.
// The re-exported handler owns its own params. ../signin/route's POST takes
// `props: { params: Promise<...> }` and awaits it, so this alias needs no
// params handling of its own. The Next 15 codemod flags every re-export
// because it cannot follow one.
export { POST } from '../signin/route'
