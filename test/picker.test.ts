import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Context, type InventoryRow, readInventory, saveInventory } from "../src/ops";
import { inventoryFile } from "../src/paths";

const ROW: InventoryRow = {
  name: "app",
  commits: 3,
  tags: 1,
  defaultBranch: "main",
  protected: "-",
  visibility: "public",
  openPullRequests: 0,
  releases: 0,
  signedLost: 0,
};

function context(): Context {
  return {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    cache: join(mkdtempSync(join(tmpdir(), "purge-git-picker-")), "cache"),
    log: () => undefined,
  };
}

describe("inventory file", () => {
  it("should give back the saved rows when the picker reads them", async () => {
    const ctx = context();
    await saveInventory(ctx, [ROW]);
    expect(await readInventory(ctx)).toEqual([ROW]);
    expect(statSync(inventoryFile(ctx.cache)).mode & 0o777).toBe(0o600);
  });

  it("should ask for an inventory when none was saved", async () => {
    await expect(readInventory(context())).rejects.toThrow(/purge-git inventory/);
  });
});
