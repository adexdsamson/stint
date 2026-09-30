---
schema_version: 1
open_count: 6
waived_count: 0
fixed_count: 0
total_count: 6
last_updated: 2026-09-30T07:08:23.065Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | packages/core/src/policy.ts |  | evaluatePolicy documents over_actions_per_hour in POLICY_REASON_CODES but does not yet enforce a sliding-window check for limits.actions_per_hour: LeaseCounters (D-01, 02-01) has no per-action timestamp field, and full concurrent-safe enforcement is PRXY-04 (Phase 4). | open |  | 2026-09-27T18:41:50.894Z |  |
| 2 | 6 | stub | packages/cli/src/commands/run.ts |  | Intentional interface stub for the run command; body implemented by a later 06 plan (05/06/07) | open |  | 2026-09-30T07:08:18.259Z |  |
| 3 | 6 | stub | packages/cli/src/commands/revoke.ts |  | Intentional interface stub for the revoke command; body implemented by a later 06 plan (05/06/07) | open |  | 2026-09-30T07:08:19.506Z |  |
| 4 | 6 | stub | packages/cli/src/commands/cleanup.ts |  | Intentional interface stub for the cleanup command; body implemented by a later 06 plan (05/06/07) | open |  | 2026-09-30T07:08:20.695Z |  |
| 5 | 6 | stub | packages/cli/src/commands/receipts.ts |  | Intentional interface stub for the receipts command; body implemented by a later 06 plan (05/06/07) | open |  | 2026-09-30T07:08:21.922Z |  |
| 6 | 6 | stub | packages/cli/src/commands/verify.ts |  | Intentional interface stub for the verify command; body implemented by a later 06 plan (05/06/07) | open |  | 2026-09-30T07:08:23.065Z |  |

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
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "6",
    "file": "packages/cli/src/commands/run.ts",
    "line": null,
    "description": "Intentional interface stub for the run command; body implemented by a later 06 plan (05/06/07)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-30T07:08:18.259Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "6",
    "file": "packages/cli/src/commands/revoke.ts",
    "line": null,
    "description": "Intentional interface stub for the revoke command; body implemented by a later 06 plan (05/06/07)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-30T07:08:19.506Z",
    "resolved_at": null
  },
  {
    "id": 4,
    "kind": "stub",
    "phase": "6",
    "file": "packages/cli/src/commands/cleanup.ts",
    "line": null,
    "description": "Intentional interface stub for the cleanup command; body implemented by a later 06 plan (05/06/07)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-30T07:08:20.695Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "stub",
    "phase": "6",
    "file": "packages/cli/src/commands/receipts.ts",
    "line": null,
    "description": "Intentional interface stub for the receipts command; body implemented by a later 06 plan (05/06/07)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-30T07:08:21.922Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "stub",
    "phase": "6",
    "file": "packages/cli/src/commands/verify.ts",
    "line": null,
    "description": "Intentional interface stub for the verify command; body implemented by a later 06 plan (05/06/07)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-30T07:08:23.065Z",
    "resolved_at": null
  }
]
````
