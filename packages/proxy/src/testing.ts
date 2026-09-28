/**
 * `@stint/proxy/testing` — the ONLY place proxy test doubles (mock
 * `OutboundConnector` implementations, mock OAuth server wiring, contract
 * test factories for proxy-owned stores) will live, mirroring
 * `@stint/core/testing`'s subpath convention (D-14 there; same discipline
 * here). The public `.` entry (`./index.ts`) never re-exports anything from
 * this file, so production code cannot accidentally depend on a test
 * double.
 *
 * This is a placeholder scaffold for plan 04-01 — later Wave-2/3 plans
 * populate it with real proxy test doubles.
 */

/** Placeholder marker proving this subpath builds and is importable; later plans replace/extend this. */
export const PROXY_TESTING_PLACEHOLDER = "@stint/proxy/testing";
