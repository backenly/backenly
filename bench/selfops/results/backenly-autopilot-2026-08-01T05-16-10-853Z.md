# selfops-bench v1 — backenly-autopilot

Generated 2026-08-01T05:16:10.852Z

- **Healer:** resident MAPE-K loop (lib/autonomy/reconciler.ts) — no agent, no session, no human
- **Plan / dial:** SANDBOX / AGGRESSIVE
- **Cycle budget:** 3 per case

## Headline

| Metric | Value |
| --- | --- |
| Repair rate (in-catalogue, unattended) | **100%** (1/1) |
| Detection rate | 100% (1/1) |
| Median cycles to detect | 1 |
| Median cycles to repair | 1 |
| Over-corrected (secured into uselessness) | 0 |
| Degraded (made worse) | 0 |
| **Control false positives** — findings raised on a healthy backend | **0** |
| **Control unrequested mutations** | **0** |
| Out-of-catalogue faults repaired | 0/0 |
| Model tokens spent across the whole suite | 0 |

Cycles, not seconds: one cycle is one full pass of the maintenance loop. Wall-clock MTTR is `cycles x cadence`; this platform reconciles every minute on every plan, so a 2-cycle repair is roughly a 2-minute repair in production.

## Per case

| Case | Task | Scope | Severity | Result | Detect | Repair | Evidence after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `rls-cross-tenant-read` | mitigation | in-catalogue | critical | PASS | 1 | 1 | role authenticated with sub=11111111 read 2 own row(s) and 0 row(s) belonging to another user |

## What each verdict means

- **PASS** — an oracle outside the control plane confirms the defect is gone *and* the legitimate path still works.
- **FAIL (over-corrected)** — the defect is gone because the feature is broken. Scored as a failure.
- **VOID** — the injection did not produce the fault, so nothing can be concluded. Never counted as a pass.
