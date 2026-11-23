import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("privacy", () => {
  it("ships no email address outside the allowlist", () => {
    const out = execFileSync(
      "node",
      ["scripts/scan-emails.mjs", "src", "test", "docs", "scripts", "README.md", "package.json"],
      { encoding: "utf8" },
    );
    expect(out).toMatch(/No email address/);
  });

  it("flags a real address", () => {
    const path = join(mkdtempSync(join(tmpdir(), "purge-git-scan-")), "leak.txt");
    writeFileSync(path, `contact: someone${"@"}mail.test.org\n`);
    const result = spawnSync("node", ["scripts/scan-emails.mjs", path], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mail.test.org");
  });
});
