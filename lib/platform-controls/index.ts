/**
 * Platform controls: the public half of what used to be lib/platform/controls.ts.
 *
 * That module mixed four separable things, and only one of them was Backenly's:
 *
 *   state.ts             operator kill switches and the guards that read them
 *   signup-slot.ts       the Phase 3 self-hosted first-operator machinery
 *   signup-admission.ts  the order the signup gates run in
 *   blocklist.ts         an explicit list somebody wrote
 *   security-events.ts   the deployment's own security audit log
 *   project-lockdown.ts  two columns on one Project
 *
 * What stayed behind is the founder console's write path. Reading and enforcing
 * a kill switch is product; Backenly's admin mutation surface is not.
 *
 * The Cloud email heuristics are not here either. They reach this code through
 * PlatformSignals, and in single-tenant they do not run.
 */
export {
  DEFAULT_STATE,
  assertAiAllowed,
  assertWritable,
  getPlatformControls,
  invalidatePlatformControlsCache,
  ok,
  type ControlPatch,
  type Guard,
  type PlatformControlState,
} from './state'

export {
  SignupSlotTakenError,
  createUserClaimingSignupSlot,
  selfHostedRegistrationClosed,
  type SignupGuard,
} from './signup-slot'

export { assertSignupAllowed } from './signup-admission'
export { invalidateBlocklistCache, isBlocked } from './blocklist'
export { recordSecurityEvent, type SecurityEventInput } from './security-events'
export { isProjectLockedDown, setProjectLockdown } from './project-lockdown'
export { assertAccountCanConsume, promoteOnEmailVerified, type StandingGuard } from './account-standing'
