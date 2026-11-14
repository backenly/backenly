/**
 * What the caller of a function is sent.
 *
 * A function's log lines are the developer's. They are kept with the run,
 * where the console shows them, and sent back only to a service-role key; an
 * app's own key, and so an end user's browser, gets the function's answer
 * without them. They used to go to every caller.
 *
 * A route module (a function written as a Next.js route handler) answers for
 * itself at /fn/{name}: its status, its body and its content type go out as it
 * wrote them. It was wrapped as { success, name, result: { status, body,
 * headers }, logs, durationMs }, so a frontend reading the handler's own
 * `error` found nothing and showed "Request failed (400)".
 */

/**
 * The status a completed run is answered with on POST /functions and
 * /functions/invoke: the one its handler chose, as at /fn/{name}, or 200 for a
 * plain function, which chooses none. They answered 200 whatever the handler
 * said, so a function that answered 401 or 503 reached its caller as a
 * success (#604). A status a response can't have is a 200.
 */
export function completedRunStatus(httpStatus: number | undefined): number {
  return typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus <= 599
    ? httpStatus
    : 200
}

/** Whether a response with this status may have a body: 204, 205 and 304 may not. */
export function statusHasBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304
}

/** The log lines this caller may be sent: all of them to a service-role key, none to anyone else. */
export function logsFor(logs: string[] | undefined, serviceRole: boolean): { logs?: string[] } {
  return serviceRole ? { logs: logs ?? [] } : {}
}

/** The headers of a route module's answer that are passed on: its content type and its caching. */
export function answerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if ((lower === 'content-type' || lower === 'cache-control') && typeof value === 'string') out[lower] = value
  }
  return out
}
