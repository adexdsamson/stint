/**
 * `@stint/proxy/testing` — the ONLY place proxy test doubles (mock
 * `OutboundConnector` implementations, mock OAuth server wiring, contract
 * test factories for proxy-owned stores) will live, mirroring
 * `@stint/core/testing`'s subpath convention (D-14 there; same discipline
 * here). The public `.` entry (`./index.ts`) never re-exports anything from
 * this file, so production code cannot accidentally depend on a test
 * double.
 *
 * `createEchoExecuteStage` is this plan's first real test double: a
 * trivial in-memory `ExecuteStage` (D-01) for the tracer test and future
 * examples. Later Wave-2/3 plans add more (mock `OutboundConnector`
 * implementations, mock OAuth server wiring).
 */

import type { ExecuteStage } from "./dispatch.js";

/** Placeholder marker proving this subpath builds and is importable; later plans replace/extend this. */
export const PROXY_TESTING_PLACEHOLDER = "@stint/proxy/testing";

/**
 * A trivial in-memory `ExecuteStage` that echoes a fixed `{ status: 200,
 * body }` result on every call -- never wired into a production `ProxyDeps`
 * by default (`dispatch.ts`'s own `DEFAULT_EXECUTE_STAGE` throws instead).
 */
export function createEchoExecuteStage(body: unknown = { echo: true }): ExecuteStage {
  return {
    execute() {
      return Promise.resolve({ status: 200, body });
    },
  };
}
