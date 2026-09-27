import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

// This file lives at packages/spec/test/license.test.ts, so the repo root is
// three levels up: test -> spec -> packages -> <repo root>.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("license", () => {
  it("root LICENSE is Apache-2.0", () => {
    const license = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("END OF TERMS AND CONDITIONS");
  });

  it("every package declares Apache-2.0 and an @stint name", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { license?: string };
    expect(rootPackageJson.license).toBe("Apache-2.0");

    const packagesDir = join(REPO_ROOT, "packages");
    const packageDirs = readdirSync(packagesDir).filter((entry) =>
      statSync(join(packagesDir, entry)).isDirectory(),
    );

    expect(packageDirs.length).toBeGreaterThan(0);

    for (const dir of packageDirs) {
      const pkgPath = join(packagesDir, dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        license?: string;
        name?: string;
      };

      expect(pkg.license, `${dir}/package.json license`).toBe("Apache-2.0");
      expect(pkg.name, `${dir}/package.json name`).toBe(`@stint/${dir}`);
    }
  });
});
