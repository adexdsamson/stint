import { describe, expect, it } from "vitest";

import type { LeaseCounters } from "../src/lease.js";

describe("LeaseCounters.actionTimestamps", () => {
  it("is carried alongside actionCount, spentMinor, and denialErrorTimestamps", () => {
    // A `LeaseCounters` value requires `actionTimestamps` (D-05/D-06):
    // this literal is a type error until the field is added to the
    // interface — that is the intentional RED failure for this plan.
    const counters: LeaseCounters = {
      actionCount: 2,
      spentMinor: 0,
      denialErrorTimestamps: [],
      actionTimestamps: [1000, 2000],
    };

    expect(counters.actionTimestamps).toEqual([1000, 2000]);
  });
});
