/**
 * WHEN A TURN STOPS STARTING WORK
 * ===============================
 * backend_chat gives a turn 90 seconds and answers when they are up. The brain
 * used to carry on after that answer: the deadline was read once per agent-loop
 * iteration, and nowhere in the blueprint executor or the architect, so tools
 * ran and changes landed after the agent had been told what the turn did, and
 * an agent that took the timeout's `retryable` at its word ran the same request
 * twice (#247).
 *
 * A turn now has one clock. It stops when the verification reserve begins (the
 * reserve is spent proving what landed) or when the caller gives up, whichever
 * comes first. From then on nothing new starts: no model call, tool, blueprint
 * step or fix, and a model call in flight is cancelled. A tool already running
 * is left to finish, because stopping DDL halfway is worse than letting it end.
 *
 * `stopped()` reads the time as well as the signal, so a step is not let
 * through just because the timer has not fired yet.
 */

export interface TurnClock {
  /** Aborts when nothing new may start. Pass it to calls that can be cancelled. */
  readonly signal: AbortSignal
  /** True once nothing new may start. */
  stopped(): boolean
  /** Clears the timer and the listener on the caller's signal. Call when the turn ends. */
  dispose(): void
}

/**
 * Start a turn's clock. `stopAt` is when the turn stops starting work (epoch
 * ms); `callerSignal` is the caller giving up. With neither, it never stops.
 */
export function startTurnClock(stopAt: number | undefined, callerSignal?: AbortSignal): TurnClock {
  const stop = new AbortController()
  const giveUp = () => stop.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (stopAt !== undefined) {
    timer = setTimeout(giveUp, Math.max(0, stopAt - Date.now()))
    timer.unref?.()
  }
  if (callerSignal?.aborted) giveUp()
  else callerSignal?.addEventListener('abort', giveUp, { once: true })

  return {
    signal: stop.signal,
    stopped: () => stop.signal.aborted || (stopAt !== undefined && Date.now() >= stopAt),
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', giveUp)
    },
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
