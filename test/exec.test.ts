import { describe, expect, it } from "vitest";
import { run } from "../src/exec";

describe("run", () => {
  it("should resolve when the child exits before reading a large stdin", async () => {
    const result = await run("true", [], { input: "x".repeat(4 * 1024 * 1024) });
    expect(result.code).toBe(0);
  });
});
