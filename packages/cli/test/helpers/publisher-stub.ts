/**
 * A loopback `node:http` publisher for CLI tests: the license issue / reissue /
 * invalidate endpoints (signing with the reference PASETO issuer) plus an
 * `/alp/cleanup` hook that just answers 200. It signs with the `now`/`exp` the
 * runtime sends, so the runtime's fake clock and the publisher agree.
 */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { LicenseClaims } from "@stint/core";
import { readLicenseToken } from "@stint/core";
import { createReferenceLicenseIssuer, exportLicensePublicKey } from "@stint/core/license-issuer";

import type { PublisherBinding } from "../../src/store/publisher-binding.js";

/** `decline`: issue works, but reissue answers `{ license: null }` (the publisher refuses to refresh). */
export type StubBehavior = "ok" | "garbage" | "wrong-lease" | "refuse" | "decline";

export interface PublisherStub {
  readonly baseUrl: string;
  readonly binding: PublisherBinding;
  /** Writes the binding as a `--publisher` file under `dir` and returns its path. */
  readonly writeBindingFile: (dir: string, name?: string) => Promise<string>;
  readonly hits: { issue: number; reissue: number; invalidate: number; cleanup: number };
  readonly invalidated: string[];
  /** The last raw license token the stub handed out (tests assert it never leaks). */
  readonly issuedTokens: string[];
  behavior: StubBehavior;
  readonly stop: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += (chunk as Buffer).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

export async function startPublisherStub(): Promise<PublisherStub> {
  const { issuer, publicKey } = await createReferenceLicenseIssuer();
  const paserk = await exportLicensePublicKey(publicKey);
  const hits = { issue: 0, reissue: 0, invalidate: 0, cleanup: 0 };
  const invalidated: string[] = [];
  const issuedTokens: string[] = [];

  const stub = { behavior: "ok" as StubBehavior };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const send = (status: number, json?: unknown): void => {
        res.statusCode = status;
        if (json !== undefined) res.setHeader("content-type", "application/json");
        res.end(json === undefined ? undefined : JSON.stringify(json));
      };
      const url = req.url ?? "";
      if (url === "/alp/cleanup") {
        hits.cleanup += 1;
        send(200);
        return;
      }
      if (url === "/license/invalidate") {
        hits.invalidate += 1;
        invalidated.push(String(body.lease_id));
        send(200);
        return;
      }
      if (url !== "/license/issue" && url !== "/license/reissue") {
        send(404);
        return;
      }
      if (url === "/license/issue") hits.issue += 1;
      else hits.reissue += 1;

      if (stub.behavior === "refuse") {
        send(500, { error: "boom: internal publisher detail" });
        return;
      }
      if (stub.behavior === "decline" && url === "/license/reissue") {
        send(200, { license: null });
        return;
      }
      if (stub.behavior === "garbage") {
        send(200, { license: "v4.public.thisisnotarealtoken" });
        return;
      }
      const claims = body.claims as LicenseClaims;
      const signed: LicenseClaims =
        stub.behavior === "wrong-lease" ? { ...claims, lease_id: "some-other-lease" } : claims;
      const now = body.now as number;
      const held =
        url === "/license/issue"
          ? await issuer.issue(signed, String(body.spec_version), now, body.exp as number)
          : await issuer.reissue(
              signed,
              String(body.spec_version),
              now,
              body.lease_expires_at as number,
            );
      if (held === null) {
        send(200, { license: null });
        return;
      }
      const token = readLicenseToken(held);
      issuedTokens.push(token);
      send(200, { license: token });
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const binding: PublisherBinding = {
    issue_url: `${baseUrl}/license/issue`,
    reissue_url: `${baseUrl}/license/reissue`,
    invalidate_url: `${baseUrl}/license/invalidate`,
    license_public_key: paserk,
  };

  return {
    baseUrl,
    binding,
    hits,
    invalidated,
    issuedTokens,
    get behavior() {
      return stub.behavior;
    },
    set behavior(value: StubBehavior) {
      stub.behavior = value;
    },
    writeBindingFile: async (dir, name = "publisher-binding.json") => {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify(binding));
      return file;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
