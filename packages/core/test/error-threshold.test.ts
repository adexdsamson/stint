import { describe, expect, it } from "vitest";

import { checkErrorThreshold } from "../src/policy.js";
import type { LeaseCounters } from "../src/lease.js";
import type { ErrorThreshold } from "@stint/spec";

function counters(
  denialErrorTimestamps: readonly number[],
): Pick<LeaseCounters, "denialErrorTimestamps"> {
  return { denialErrorTimestamps };
}

describe("checkErrorThreshold", () => {
  it("N TRIPS: 3 timestamps within a 60s window at count:3 trips true", () => {
    const threshold: ErrorThreshold = { count: 3, window_seconds: 60 };

    expect(checkErrorThreshold(counters([980, 990, 1000]), threshold, 1000)).toBe(true);
  });

  it("N-1 DOES NOT: only 2 timestamps within the window at count:3 stays false", () => {
    const threshold: ErrorThreshold = { count: 3, window_seconds: 60 };

    expect(checkErrorThreshold(counters([990, 1000]), threshold, 1000)).toBe(false);
  });

  it("WINDOW BOUNDARY: a timestamp exactly window_seconds old is OUTSIDE the window (strict >)", () => {
    const threshold: ErrorThreshold = { count: 3, window_seconds: 60 };

    // now - window_seconds = 940: exactly on the boundary, excluded -> only 2 in-window -> false.
    expect(checkErrorThreshold(counters([940, 990, 1000]), threshold, 1000)).toBe(false);

    // 941 is one second inside the window -> 3 in-window -> true.
    expect(checkErrorThreshold(counters([941, 990, 1000]), threshold, 1000)).toBe(true);
  });

  it("EMPTY: no timestamps never trips", () => {
    const threshold: ErrorThreshold = { count: 3, window_seconds: 60 };

    expect(checkErrorThreshold(counters([]), threshold, 1000)).toBe(false);
  });

  it("STALE PRUNING: timestamps far older than the window never count", () => {
    const threshold: ErrorThreshold = { count: 1, window_seconds: 60 };

    expect(checkErrorThreshold(counters([100, 200]), threshold, 1000)).toBe(false);
  });
});
