import { describe, expect, it } from "vitest";
import { findOverlaps } from "./overlap";

describe("findOverlaps", () => {
  it("returns no overlaps when variants are disjoint", () => {
    expect(
      findOverlaps(["v1", "v2"], [{ saleId: "s1", variantIds: new Set(["v3"]) }]),
    ).toEqual([]);
  });

  it("lists overlapping variants per other sale, sorted", () => {
    const result = findOverlaps(
      ["v3", "v1", "v2"],
      [
        { saleId: "s1", variantIds: new Set(["v2", "v9"]) },
        { saleId: "s2", variantIds: new Set(["v3", "v1"]) },
        { saleId: "s3", variantIds: new Set(["v8"]) },
      ],
    );
    expect(result).toEqual([
      { saleId: "s1", variantIds: ["v2"] },
      { saleId: "s2", variantIds: ["v1", "v3"] },
    ]);
  });

  it("ignores duplicate candidate ids", () => {
    const result = findOverlaps(["v1", "v1"], [{ saleId: "s1", variantIds: new Set(["v1"]) }]);
    expect(result).toEqual([{ saleId: "s1", variantIds: ["v1"] }]);
  });
});
