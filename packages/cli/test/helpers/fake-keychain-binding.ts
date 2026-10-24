/**
 * An in-memory `KeychainBinding` double for tests. Entries live in a `Map`
 * keyed by `service + "\u0000" + account`, and `set` throws when a value
 * exceeds the per-entry byte cap (default 2560 bytes) — mirroring the Windows
 * Credential Manager limit, so the chunking path is exercised on every OS.
 */

import type { KeychainBinding } from "../../src/store/keychain-binding.js";

const SEP = "\u0000";

export class FakeKeychainBinding implements KeychainBinding {
  private readonly entries = new Map<string, Uint8Array>();

  constructor(private readonly maxEntryBytes = 2560) {}

  set(service: string, account: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxEntryBytes) {
      return Promise.reject(new Error("fake keychain: value exceeds the per-entry byte cap"));
    }
    // Copy so the stored bytes are independent of the caller's buffer.
    this.entries.set(service + SEP + account, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  get(service: string, account: string): Promise<Uint8Array | undefined> {
    const value = this.entries.get(service + SEP + account);
    return Promise.resolve(value === undefined ? undefined : Uint8Array.from(value));
  }

  delete(service: string, account: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(service + SEP + account));
  }

  // --- test inspection ------------------------------------------------------

  /** Number of stored entries (heads + chunks). */
  get size(): number {
    return this.entries.size;
  }

  /** Whether an entry exists under (service, account). */
  has(service: string, account: string): boolean {
    return this.entries.has(service + SEP + account);
  }

  /** All stored `service\u0000account` keys. */
  accountKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** All stored values, as a flat list of byte arrays. */
  values(): Uint8Array[] {
    return [...this.entries.values()];
  }
}
