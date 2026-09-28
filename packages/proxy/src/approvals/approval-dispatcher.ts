/**
 * RED-phase stub for `createApprovalDispatcher`/`computeApprovalHash`
 * (PRXY-05, D-11, Task 2 TDD cycle) -- deliberately naive so
 * `approvals.test.ts`'s target-behavior assertions fail for the right
 * reason (never arms a timer, never calls the adapter, ignores its inputs
 * when hashing) rather than via an import/compile crash. Replaced by the
 * real implementation in the GREEN commit.
 */

import { hashCanonical } from "@stint/spec";
import type { ContentHash } from "@stint/spec";

import type { ApprovalDecision, ApprovalStage, CallContext } from "../dispatch.js";

export interface PendingApproval {
  readonly approvalId: string;
  readonly commitmentHash: ContentHash;
  readonly requestedAt: number;
}

export function computeApprovalHash(): ContentHash {
  // Deliberately ignores its inputs -- every call yields the same hash.
  return hashCanonical({ stub: true });
}

export function createApprovalDispatcher(): ApprovalStage {
  return {
    requestApproval(_ctx: CallContext): Promise<ApprovalDecision> {
      // Deliberately never arms a timer and never calls the adapter --
      // always approves immediately.
      return Promise.resolve({ decision: "approve", approvalId: "stub" });
    },
    verifyCommitment(): boolean {
      return true;
    },
  };
}
