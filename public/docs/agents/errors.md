# Errors

Index: https://backenly.com/llms.txt

Every tool and route answers failures as JSON: `{ ok: false, error, code }`, often with `hint`, and over MCP also as `structuredContent` with a second text block saying what the fields mean for your next step. Branch on `code`, not on the message.

| Code | Meaning | What to do |
| --- | --- | --- |
| `RATE_LIMITED` | Too many calls | Wait for `retry-after`, then retry |
| `PLAN_LIMIT_EXCEEDED` | The plan's limit is reached | Tell your human; do not retry in a loop |
| `AI_CREDITS_EXHAUSTED` | No AI credits left | Only `backend_chat` and `functions` `create` spend credits; every other tool still works |
| `READ_ONLY_KEY` | This key may only read | Ask your human for a read-write key |
| `DESTRUCTIVE_NEEDS_APPROVAL` | A destructive tool was called directly | Use the section tool's action, which parks it for approval (`autonomy`) |
| `INVALID_KEY` / `NO_AUTH` | The key is missing, wrong or revoked | Ask your human for a new key from Connect → Agents |
| `PROJECT_PAUSED` | The project is paused | Your human resumes it in the dashboard |
| `UNKNOWN_ACTION` | A section tool got an action it does not have | The response lists `supported` |
| `UNKNOWN_PARAMS` | An argument the tool does not take | The response lists `unsupported` and `supported` |
| `UNSUPPORTED_PARAMS` | An argument asking for work the tool cannot do (`select`, `groupBy`, `join` on a row tool) | Use the tool the `hint` names, usually `run_query` |
| `BAD_BODY` / `INVALID_ARGUMENT` | An argument has the wrong shape, or a required one is missing | Fix the argument the message names |
| `NOT_FOUND` / `PROJECT_NOT_FOUND` | The thing does not exist in this project, or this key may not see it | List what exists, then retry |
| `FUNCTION_FAILED` | A function threw or timed out when invoked | Read the error and `functions` `logs`; the code was not changed |
| `FUNCTION_INACTIVE` | The function is switched off | Turn it on with `functions` `set_active` first |
| `INVALID_CODE` / `SECRET_IN_CODE` / `CODE_TOO_LARGE` | `functions` `deploy_code` refused the source | Fix what the summary names; nothing was stored |
| `BRANCH_INACTIVE` | The key is bound to a branch that was merged or discarded | Use a key for an active branch or the main schema |

Database errors name the column, the expected type and the value received. A result with `partial` means some changes landed before the run stopped: read state before replaying anything.
