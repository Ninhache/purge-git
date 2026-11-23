import { describe, expect, it } from "vitest";
import type { Run } from "../src/exec";
import { mailmapFile, messagesFile, parseRefs, refusalOf, sameRefs, scan } from "../src/git";

describe("git helpers", () => {
  it("keeps only branches and tags, without peeled entries", () => {
    const refs = parseRefs(
      "a refs/heads/main\nb refs/tags/v1\nc refs/tags/v1^{}\nd refs/pull/1/head\ne HEAD\n",
    );
    expect(refs).toEqual({ "refs/heads/main": "a", "refs/tags/v1": "b" });
  });

  it("compares ref sets both ways", () => {
    expect(sameRefs({ a: "1" }, { a: "1" })).toBe(true);
    expect(sameRefs({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameRefs({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });

  it("maps every old address to the identity", () => {
    expect(
      mailmapFile({ name: "Me", email: "new@example.com" }, ["a@example.com", "b@example.com"]),
    ).toBe("Me <new@example.com> <a@example.com>\nMe <new@example.com> <b@example.com>\n");
  });

  it("escapes addresses in the case-insensitive message rules", () => {
    expect(messagesFile("new@example.com", ["a.b+c@example.com"])).toBe(
      "regex:(?i)a\\.b\\+c@example\\.com==>new@example.com\n",
    );
  });

  it("names the reason of a refused push", () => {
    expect(refusalOf("remote: error: GH007: Your push would publish a private email")).toBe(
      "email-privacy",
    );
    expect(refusalOf("remote: error: GH006: Protected branch update failed")).toBe("protected");
    expect(refusalOf("remote: error: GH013: Repository rule violations found")).toBe("ruleset");
    expect(refusalOf("fatal: could not read")).toBe("other");
  });

  it("counts signed commits rewritten because an ancestor is", async () => {
    const record = (sha: string, parents: string, email: string, signed: string) =>
      `${sha}\u0000${parents}\u0000${email}\u0000${email}\u0000${signed}\u0000msg\n\u001e`;
    const log = [
      record("a", "", "me@example.com", "G"),
      record("b", "a", "old@example.com", "N"),
      record("c", "b", "me@example.com", "G"),
      record("d", "a", "me@example.com", "E"),
    ].join("\n");
    const fake: Run = async (_command, args) => {
      if (args.includes("rev-list")) return { code: 0, stdout: "a\n", stderr: "" };
      if (args.includes("log")) return { code: 0, stdout: log, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await scan(fake, "/repo", ["old@example.com"]);
    expect(result.commits).toBe(4);
    expect(result.matching).toBe(1);
    expect(result.signedLost).toBe(1);
  });
});
