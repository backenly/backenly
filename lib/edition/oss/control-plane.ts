/**
 * Is the Cloud control plane part of this build?
 *
 * `@cloud/control-plane` resolves here only when `lib/cloud/control-plane.ts`
 * is absent, which means no Cloud overlay has been applied. The overlay ships
 * the same module with the flag set true.
 *
 * ---- WHY A BUILD-TIME CONSTANT AND NOT AN ENV VAR ------------------------
 *
 * The surfaces this gates are client components: a navigation list, a command
 * palette. They cannot read BACKENLY_EDITION, and giving them a
 * NEXT_PUBLIC_ mirror would make correct navigation depend on a self-hoster
 * setting a second variable consistently with the first. Getting it wrong would
 * render menu items that route to pages the build does not contain.
 *
 * The alias resolves at build time, so this constant is exactly true when the
 * files behind it exist, with nothing to configure and nothing to keep in sync.
 *
 * ---- WHAT IT MUST NOT BE USED FOR ---------------------------------------
 *
 * Authorization. This says which SURFACES exist, never who may reach one. A
 * client-side constant is visible to anyone reading the bundle and is trivially
 * flipped in a debugger; every access decision stays server-side in
 * ProjectResolver. Gating a menu item is presentation, and a caller who
 * hand-crafts the request still meets the same server checks.
 */

/** False: this build has no organizations, no team billing, no fleet. */
export const CLOUD_CONTROL_PLANE = false
