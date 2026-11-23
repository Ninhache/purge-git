import { describe, expect, it } from "vitest";
import type { Run } from "../src/exec";
import { ownedRepos, searchPages } from "../src/github";

describe("searchPages", () => {
  it("should stop paging when a page comes back short", async () => {
    const pages: string[] = [];
    const runner: Run = async (_command, args) => {
      const page = args.find((arg) => arg.startsWith("page=")) ?? "";
      pages.push(page);
      const items =
        page === "page=1" ? Array.from({ length: 100 }, (_, n) => ({ n })) : [{ n: 100 }];
      return { code: 0, stdout: JSON.stringify({ total_count: 101, items }), stderr: "" };
    };
    const found = await searchPages(runner, { q: "author:me" }, async () => undefined);
    expect(found.total).toBe(101);
    expect(found.items).toHaveLength(101);
    expect(pages).toEqual(["page=1", "page=2"]);
  });
});

describe("ownedRepos", () => {
  it("should leave out repos you cannot push to when listing an org", async () => {
    const repo = (name: string, viewerPermission: string) => ({
      name,
      visibility: "PRIVATE",
      defaultBranchRef: { name: "main" },
      isFork: false,
      isArchived: false,
      viewerPermission,
    });
    const rows = [repo("admin", "ADMIN"), repo("writer", "WRITE"), repo("reader", "READ")];
    const runner: Run = async () => ({ code: 0, stdout: JSON.stringify(rows), stderr: "" });
    const names = (await ownedRepos(runner, "acme")).map((item) => item.name);
    expect(names).toEqual(["admin", "writer"]);
  });
});
