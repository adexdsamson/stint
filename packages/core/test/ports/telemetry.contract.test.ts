import { describe, expect, it } from "vitest";

import type { Telemetry, TelemetryEvent } from "../../src/ports/telemetry.js";
import { NOOP_TELEMETRY } from "../../src/ports/telemetry.js";
import { createRecordingTelemetry, createTelemetryContractTests } from "../../src/testing.js";

/** A second implementation written only from the `Telemetry` type. */
function makeIndependentTelemetry(): Telemetry {
  const seen: TelemetryEvent[] = [];
  return {
    emit(event) {
      seen.push(event);
    },
  };
}

createTelemetryContractTests(() => NOOP_TELEMETRY);
createTelemetryContractTests(() => createRecordingTelemetry());
createTelemetryContractTests(() => makeIndependentTelemetry());

describe("createRecordingTelemetry", () => {
  it("records events in emission order", () => {
    const telemetry = createRecordingTelemetry();
    telemetry.emit({ name: "teardown.step", leaseId: "lease-1", step: "revoke_oauth", outcome: "revoked" });
    telemetry.emit({ name: "teardown.blocked", leaseId: "lease-1", reason: "credentials_unavailable", resourceCount: 1 });
    expect(telemetry.events.map((event) => event.name)).toEqual(["teardown.step", "teardown.blocked"]);
  });
});
