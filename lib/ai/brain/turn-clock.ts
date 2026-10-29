/**
 * WHEN A TURN STOPS STARTING WORK
 * ===============================
 * A backend_chat request is a run with its own time limit (lib/ai/brain/runs.ts),
 * and the brain keeps a verification reserve at the end of it. The deadline was
 * read once per agent-loop iteration, and nowhere in the blueprint executor, so
 * the calls of a model answer that came back just before the reserve all ran
 * past it, and a long plan and its post-build fixes ran on past the limit for
 * as long as they took (#247).
 *
 * A turn now has one clock. It stops when the verification reserve begins (the
 * reserve is spent proving what landed). From then on nothing new starts: no
 * agent-loop model call, tool, blueprint step or fix, and a model call in
 * flight is cancelled. A tool already running is left to finish, because
 * stopping DDL halfway is worse than letting it end.
 *
 * `stopped()` reads the time as well as the signal, so a step is not let
 * through just because the timer has not fired yet.
 */

export interface TurnClock {
  /** Aborts when nothing new may start. Pass it to calls that can be cancelled. */
  readonly signal: AbortSignal
  /** True once nothing new may start. */
  stopped(): boolean
  /** Clears the timer. Call when the turn ends. */
  dispose(): void
}

/**
 * Start a turn's clock. `stopAt` is when the turn stops starting work (epoch
 * ms); without it, it never stops.
 */
export function startTurnClock(stopAt: number | undefined): TurnClock {
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (stopAt !== undefined) {
    timer = setTimeout(() => stop.abort(), Math.max(0, stopAt - Date.now()))
    timer.unref?.()
  }

  return {
    signal: stop.signal,
    stopped: () => stop.signal.aborted || (stopAt !== undefined && Date.now() >= stopAt),
    dispose: () => clearTimeout(timer),
  }
}

/**
 * A signal for one cancellable call, aborted when the clock stops. Each call
 * gets its own, so the providers' listeners collect on a signal that is thrown
 * away with the call instead of on the turn's, which lives for every step.
 */
export function callSignal(clock: TurnClock): { signal: AbortSignal; release: () => void } {
  const call = new AbortController()
  const cancel = () => call.abort()
  if (clock.signal.aborted) call.abort()
  else clock.signal.addEventListener('abort', cancel, { once: true })
  return { signal: call.signal, release: () => clock.signal.removeEventListener('abort', cancel) }
}
