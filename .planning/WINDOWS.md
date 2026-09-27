---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-09-27T18:41:50.894Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | packages/core/src/policy.ts |  | evaluatePolicy documents over_actions_per_hour in POLICY_REASON_CODES but does not yet enforce a sliding-window check for limits.actions_per_hour: LeaseCounters (D-01, 02-01) has no per-action timestamp field, and full concurrent-safe enforcement is PRXY-04 (Phase 4). | open |  | 2026-09-27T18:41:50.894Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "02",
    "file": "packages/core/src/policy.ts",
    "line": null,
    "description": "evaluatePolicy documents over_actions_per_hour in POLICY_REASON_CODES but does not yet enforce a sliding-window check for limits.actions_per_hour: LeaseCounters (D-01, 02-01) has no per-action timestamp field, and full concurrent-safe enforcement is PRXY-04 (Phase 4).",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-27T18:41:50.894Z",
    "resolved_at": null
  }
]
````
