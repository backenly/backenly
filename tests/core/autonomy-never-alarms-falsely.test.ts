/**
 * AUTONOMY NEVER ALARMS FALSELY
 * =============================
 * A customer created a project, connected nothing, built nothing, and was
 * emailed a critical "contract surface broken" alert minutes later. The alert
 * read "runtime unreachable at http://127.0.0.1:3001": the monitor in the web
 * task was knocking on an empty port, and the platform's own fault was filed
 * against the customer's project and sent to their inbox.
 *
 * Each block below pins one of the rules that make that impossible, and each
 * was checked to fail with its fix reverted.
 */

import { probeOrigin } from '@/lib/services/contract-verifier'

describe('the probe enters where customer traffic enters', () => {
  it('uses an explicit CONTRACT_PROBE_ORIGIN verbatim', () => {
    expect(probeOrigin({ CONTRACT_PROBE_ORIGIN: 'http://web.internal:3000/' } as any)).toBe(
      'http://web.internal:3000',
    )
  })

  it('probes the web ingress when Next fronts a separate runtime (AWS, compose)', () => {
    // RUNTIME_API_URL is what makes Next rewrite /api/v1 to a runtime in
    // another task. The web process itself is the ingress, and :3001 is empty.
    expect(
      probeOrigin({ RUNTIME_API_URL: 'http://runtime.internal:3001', PORT: '3000', RUNTIME_PORT: '3001' } as any),
    ).toBe('http://127.0.0.1:3000')
  })

  it('probes the Express runtime on a single box where it fronts Next', () => {
    expect(probeOrigin({ RUNTIME_PORT: '4001' } as any)).toBe('http://127.0.0.1:4001')
    expect(probeOrigin({} as any)).toBe('http://127.0.0.1:3001')
  })
})
