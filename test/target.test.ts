import { describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import type { Run } from "../src/exec";
import { targetOf, withOrgs } from "../src/target";
import { IDENTITY, OLD } from "./helpers";

const config: Config = { owner: "Me", identity: IDENTITY, oldEmails: OLD, orgs: ["Acme"] };

describe("targetOf", () => {
  it("should resolve a bare name to your own repo", () => {
    expect(targetOf(config, "app")).toEqual({ owner: "Me", name: "app", label: "app" });
  });

  it("should resolve org/name to a configured org whatever its case", () => {
    expect(targetOf(config, "acme/app")).toEqual({ owner: "Acme", name: "app", label: "Acme/app" });
  });

  it("should treat your own login as a bare name when it is written out", () => {
    expect(targetOf(config, "me/app").label).toBe("app");
  });

  it("should refuse an owner that is not in the config", () => {
    expect(() => targetOf(config, "stranger/app")).toThrow(/Add it to "orgs"/);
  });

  it("should refuse a path that is not a repository name", () => {
    for (const value of ["a/b/c", "../x", "acme/..", "acme/", "a b"]) {
      expect(() => targetOf(config, value)).toThrow(/Not a repository name/);
    }
  });
});

describe("withOrgs", () => {
  const listing =
    (code: number): Run =>
    async () => ({ code, stdout: "acme\nbeta\n", stderr: "" });
  const bare: Config = { owner: "Me", identity: IDENTITY, oldEmails: OLD };

  it("should take every org of the account when the config names none", async () => {
    expect((await withOrgs(listing(0), bare, () => undefined)).orgs).toEqual(["acme", "beta"]);
  });

  it("should keep the config's own list when it has one", async () => {
    const config = { ...bare, orgs: [] };
    expect((await withOrgs(listing(0), config, () => undefined)).orgs).toEqual([]);
  });

  it("should fall back to no org and say why when gh cannot list them", async () => {
    const logs: string[] = [];
    const config = await withOrgs(listing(1), bare, (line) => logs.push(line));
    expect(config.orgs).toEqual([]);
    expect(logs.join("\n")).toMatch(/-s read:org/);
  });
});
