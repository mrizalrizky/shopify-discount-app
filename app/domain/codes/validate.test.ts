import { describe, expect, it } from "vitest";
import { codeKey, MAX_CODE_LENGTH, validateCodes } from "./validate";

describe("codeKey", () => {
  it("trims and upper-cases", () => {
    expect(codeKey("  summer10 ")).toBe("SUMMER10");
  });
});

describe("validateCodes", () => {
  it("accepts clean codes, trimmed, keeping their casing", () => {
    expect(validateCodes([" GDI23-OL013 ", "vip-Ana"], new Set())).toEqual({
      valid: ["GDI23-OL013", "vip-Ana"],
      issues: [],
    });
  });

  it("skips blank lines silently", () => {
    expect(validateCodes(["A1", "", "   ", "B2"], new Set())).toEqual({
      valid: ["A1", "B2"],
      issues: [],
    });
  });

  it("reports duplicates that differ only by case or whitespace", () => {
    expect(validateCodes(["summer10", " SUMMER10 ", "Summer10"], new Set())).toEqual({
      valid: ["summer10"],
      issues: [
        { code: "SUMMER10", reason: "duplicate_in_list" },
        { code: "Summer10", reason: "duplicate_in_list" },
      ],
    });
  });

  it("reports codes that already exist for the shop, case-insensitively", () => {
    expect(validateCodes(["old-code", "new-code"], new Set(["OLD-CODE"]))).toEqual({
      valid: ["new-code"],
      issues: [{ code: "old-code", reason: "already_exists" }],
    });
  });

  it("reports whitespace inside a code and overly long codes", () => {
    const long = "A".repeat(MAX_CODE_LENGTH + 1);
    expect(validateCodes(["HELLO WORLD", long, "OK"], new Set())).toEqual({
      valid: ["OK"],
      issues: [
        { code: "HELLO WORLD", reason: "contains_whitespace" },
        { code: long, reason: "too_long" },
      ],
    });
  });

  it("accepts a code of exactly the maximum length", () => {
    const max = "A".repeat(MAX_CODE_LENGTH);
    expect(validateCodes([max], new Set()).valid).toEqual([max]);
  });
});
