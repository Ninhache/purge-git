import { describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import { targetOf } from "../src/target";
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
