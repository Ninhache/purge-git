import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRepoName, loadConfig, TEMPLATE, writeTemplate } from "../src/config";

const valid = {
  owner: "me",
  identity: { name: "Me", email: "1+me@users.noreply.github.com" },
  oldEmails: ["old@example.com"],
};

function file(content: unknown, mode: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "purge-git-config-")), "config.json");
  writeFileSync(path, JSON.stringify(content), { mode });
  return path;
}

describe("config", () => {
  it("loads a private, valid config", async () => {
    expect(await loadConfig(file(valid, 0o600))).toEqual(valid);
  });

  it("refuses a config other users can read", async () => {
    await expect(loadConfig(file(valid, 0o644))).rejects.toThrow(/readable by others/);
  });

  it("refuses an identity that is one of the old emails", async () => {
    const config = { ...valid, oldEmails: ["1+ME@users.noreply.github.com"] };
    await expect(loadConfig(file(config, 0o600))).rejects.toThrow(/cannot be one of the old/);
  });

  it("refuses a config with no old email", async () => {
    await expect(loadConfig(file({ ...valid, oldEmails: [] }, 0o600))).rejects.toThrow(
      /Invalid config/,
    );
  });

  it("writes a private template once", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "purge-git-config-")), "sub", "config.json");
    expect(await writeTemplate(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await writeTemplate(path)).toBe(false);
    expect(TEMPLATE.oldEmails[0]).toMatch(/@example\.com$/);
  });

  it("only accepts plain repository names", () => {
    expect(isRepoName("my-repo.js")).toBe(true);
    expect(isRepoName("../etc")).toBe(false);
    expect(isRepoName("..")).toBe(false);
    expect(isRepoName("a/b")).toBe(false);
  });
});
