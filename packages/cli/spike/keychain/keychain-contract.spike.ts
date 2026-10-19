// THROWAWAY spike (never merges). Bonus beyond A9: the unmodified shared
// SecretStore contract suite against a chunked store on the REAL keychain,
// inside the fork pool.
import { randomUUID } from "node:crypto";

import * as keyring from "@napi-rs/keyring";

import { assertValidSecretKey, assertValidSecretPrefix } from "@stint/core";
import { createSecretStoreContractTests } from "@stint/core/testing";

// @ts-expect-error plain-JS spike module
import { createKeychainSecretStore } from "./store.mjs";

createSecretStoreContractTests(() =>
  createKeychainSecretStore({
    service: `stint-spike-contract-${randomUUID()}`,
    keyring,
    validateKey: assertValidSecretKey,
    validatePrefix: assertValidSecretPrefix,
  }),
);
