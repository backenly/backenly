# How AI calls are reserved and settled

Every model call goes through the AI gateway (`lib/ai/llm`). Its cost is reserved before the request is sent and settled after the answer comes back (`lib/ai/llm/spend.ts`).

## Limits

A deployment can set two monthly limits, in US dollars, for the calendar month in UTC.

| Variable | Counts |
|---|---|
| `AI_TOTAL_MONTHLY_HARD_LIMIT_USD` | Every call, whoever pays for it. On Backenly Cloud it protects the AWS credits that pay for Bedrock. |
| `AI_PLATFORM_MONTHLY_BUDGET_USD` | Calls the deployment pays for itself, as opposed to calls billed to a customer. Today those are the `autonomy.*` purposes. |

- **Unset** means no limit. Every call is still recorded.
- **Not a number** (a typo) is treated as zero, so it blocks every call instead of quietly allowing unlimited spend.

When a limit is reached, the call is not sent. It fails with `spend_limit`, and the caller shows the error's user message. Deterministic work, such as the autonomy loop's checks and repairs, does not depend on these calls and carries on.

## Reserving

Before a request is sent, its worst case is reserved against each limit that applies:

- every prompt token is estimated generously and priced as a cache write;
- the full output ceiling is priced as output.

The check and the increment are one conditional `UPDATE` on `ai_spend_periods`. Two concurrent calls cannot both pass the check on the same remaining room: the row lock makes the second one wait and check again. `tests/integration/ai-spend-ledger.spec.ts` runs 20 concurrent reservations against a limit with room for 10, and exactly 10 are granted.

**If the reservation cannot be written, the call is not sent.** It fails with `spend_unavailable`. A call nothing has accounted for could pass a limit, so unrecorded spend is never allowed.

Each reservation is also a row in `ai_spend_holds`, with an expiry past the call's last possible attempt.

## Settling: three outcomes

Every call ends in exactly one of these. `AiError.consumption` says which.

| Outcome | When | The deployment's ledger | A customer |
|---|---|---|---|
| **Ran** | The provider returned an answer with its usage. This includes a refusal or an answer cut off at the output ceiling. | Charged the real cost, from the provider's own token counts. | Charged the same real cost. |
| **None** | The request was never sent, or the provider refused it before running inference: invalid request, bad credentials, no model access, throttling, overload. | Charged nothing; the reservation is released. | Charged nothing. |
| **Unknown** | The request was sent and the answer was lost: a timeout, a dropped connection, a server error, or the process dying mid-call. | The full reservation is booked as unknown usage, which counts against both limits. | Charged nothing. |

A timeout is not proof that nothing ran. The provider may have done the work and billed for it. So:

- the deployment books an unknown outcome at the conservative upper bound;
- a customer is never charged for an answer they did not receive.

Every unknown booking is logged.

**Retries.** Only failures that were refused before inference (throttling, overload) are retried. A failure whose outcome is unknown is never retried, because a retry could run, and be billed, a second time.

**Abandoned reservations.** If the process dies after reserving, the reservation stays open until its expiry. It is then booked as unknown. The expiry check runs at most once a minute per process, before new reservations.

## Customer billing

Customer-paid calls go through a `CustomerSpendHook`. The default is the credit hold in `lib/entitlements/credit-holds.ts`, one `ai_credit_holds` row per call with its own expiry:

| State | When | Counts against the cap |
|---|---|---|
| `reserved` | Before the call is sent, taken under a per-account lock while any credit is left once credits already charged + every live hold are counted. Otherwise the call is refused unsent with `credits_exhausted`. | Its worst case |
| `used` | The call ran inside a turn. | What it actually used, until the turn is charged |
| `charged` | The turn was charged (`closeCreditTurn`). | No, the usage is in the charged total now |
| `released` | The call never ran, its answer was lost, its turn was charged nothing, or it ran outside any turn. | No |

The last call may go over. A call starts while any credit is left, not only when its worst case fits: a model call's worst case (a full prompt and its whole output ceiling) is several times what a call uses, so requiring it locked an account out with a large part of its allowance unspent. Its hold still counts that worst case, so the next call waits for it to settle. An account therefore goes over its credits by at most one call, and only by what that call used. Nothing past the account's credits is billed.

`closeCreditTurn` charges first, then marks the turn's holds charged. In between, usage is counted twice, which is the safe direction; it is never counted zero times, so a finished call can no longer leave a gap another call slips into. If the charge fails, the holds stay counted until they expire: a billing fault can cost revenue but never frees credits a call used. The charge is Cloud's commercial write (`recordAiConsumption`), which is why the two steps are ordered rather than one transaction.

Settling only moves a hold out of `reserved`, so a late settlement after its turn closed changes nothing. A reserved hold expires with the gateway's own reservation; a used one 15 minutes after its call. Each hold expires on its own, so a busy account never keeps a stranded one alive.

The customer is never charged for a call that did not run or whose answer was lost. A hold that cannot be written refuses the call with `spend_unavailable`. Where there are no finite credits (a self-hosted install, an unlimited plan, or entitlements that cannot be read), nothing is held. The deployment's own limits apply either way. `setCustomerSpendHook(null)` turns holds off.

Platform-paid calls (`autonomy.*`: investigations and repair proposals) never touch customer credits. They count only against the deployment's own limits.

## Where to look

| Question | Answer |
|---|---|
| This month's spend | `ai_spend_periods`: one row per month and scope (`total`, `platform`), with reserved, settled and unknown dollars. |
| One call | `ai_spend_holds`: its reservation, status, charge and expiry. |
| Token detail | `ai_usage`, written by the cost tracker. |

On Bedrock, the AWS invoice is the record of what AWS actually charged. An AWS Budgets alert on that line is the outer limit.
