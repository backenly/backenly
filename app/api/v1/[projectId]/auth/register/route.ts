export const dynamic = 'force-dynamic'

// Alias: /auth/register → /auth/signup
// AI platforms (Lovable, Replit, Base44) generate /auth/register by convention.
// The re-exported handler owns its own params. ../signup/route's POST takes
// `props: { params: Promise<...> }` and awaits it, so this alias needs no
// params handling of its own. The Next 15 codemod flags every re-export
// because it cannot follow one.
export { POST } from '../signup/route'
