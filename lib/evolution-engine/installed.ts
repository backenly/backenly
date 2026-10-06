/**
 * The primitives this deployment's engine can use.
 *
 * One import per primitive, and the only place the engine depends on a
 * concrete kind of change. Adding a primitive is adding a line here; nothing in
 * the engine's governance, lifecycle, consent, observation or memory changes.
 */

import '@/lib/structural-evolution/primitive'
