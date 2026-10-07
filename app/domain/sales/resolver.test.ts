import { describe, expect, it } from "vitest";
import { resolveSale, type CatalogIndex, type RuleGroupInput } from "./resolver";

const catalog: CatalogIndex = {
  collectionProducts: new Map([
    ["col-tops", ["p-shirt", "p-blouse"]],
    ["col-new", ["p-blouse", "p-skirt"]],
    ["col-empty", []],
  ]),
  productVariants: new Map([
    ["p-shirt", ["v-shirt-s", "v-shirt-m"]],
    ["p-blouse", ["v-blouse-s"]],
    ["p-skirt", ["v-skirt-s", "v-skirt-m"]],
  ]),
};

const pct = (amount: number) => ({ type: "percentOff" as const, amount });

function group(partial: Partial<RuleGroupInput> & { id: string }): RuleGroupInput {
  return { priority: 1, discount: pct(10), targets: [], exclusions: [], ...partial };
}

describe("resolveSale", () => {
  it("expands a collection into all its variants", () => {
    const result = resolveSale(
      [group({ id: "g1", targets: [{ kind: "collection", id: "col-tops" }] })],
      catalog,
    );
    expect(result).toEqual([
      { variantId: "v-blouse-s", productId: "p-blouse", ruleGroupId: "g1" },
      { variantId: "v-shirt-m", productId: "p-shirt", ruleGroupId: "g1" },
      { variantId: "v-shirt-s", productId: "p-shirt", ruleGroupId: "g1" },
    ]);
  });

  it("removes excluded products and variants", () => {
    const result = resolveSale(
      [
        group({
          id: "g1",
          targets: [{ kind: "collection", id: "col-tops" }],
          exclusions: [
            { kind: "product", id: "p-blouse" },
            { kind: "variant", id: "v-shirt-m" },
          ],
        }),
      ],
      catalog,
    );
    expect(result.map((r) => r.variantId)).toEqual(["v-shirt-s"]);
  });

  it("lets a more specific target win over a lower priority number", () => {
    const result = resolveSale(
      [
        group({ id: "collection-group", priority: 1, targets: [{ kind: "collection", id: "col-tops" }] }),
        group({ id: "product-group", priority: 9, targets: [{ kind: "product", id: "p-shirt" }] }),
        group({ id: "variant-group", priority: 9, targets: [{ kind: "variant", id: "v-shirt-s" }] }),
      ],
      catalog,
    );
    const byVariant = Object.fromEntries(result.map((r) => [r.variantId, r.ruleGroupId]));
    expect(byVariant).toEqual({
      "v-blouse-s": "collection-group",
      "v-shirt-m": "product-group",
      "v-shirt-s": "variant-group",
    });
  });

  it("breaks collection ties by lower priority number", () => {
    const result = resolveSale(
      [
        group({ id: "tops", priority: 2, targets: [{ kind: "collection", id: "col-tops" }] }),
        group({ id: "new", priority: 1, targets: [{ kind: "collection", id: "col-new" }] }),
      ],
      catalog,
    );
    const blouse = result.find((r) => r.variantId === "v-blouse-s");
    expect(blouse?.ruleGroupId).toBe("new");
  });

  it("breaks equal priority ties by group order", () => {
    const result = resolveSale(
      [
        group({ id: "first", priority: 1, targets: [{ kind: "collection", id: "col-tops" }] }),
        group({ id: "second", priority: 1, targets: [{ kind: "collection", id: "col-new" }] }),
      ],
      catalog,
    );
    const blouse = result.find((r) => r.variantId === "v-blouse-s");
    expect(blouse?.ruleGroupId).toBe("first");
  });

  it("exclusions only apply to their own group", () => {
    const result = resolveSale(
      [
        group({
          id: "g1",
          targets: [{ kind: "collection", id: "col-tops" }],
          exclusions: [{ kind: "product", id: "p-blouse" }],
        }),
        group({ id: "g2", priority: 5, targets: [{ kind: "collection", id: "col-new" }] }),
      ],
      catalog,
    );
    const blouse = result.find((r) => r.variantId === "v-blouse-s");
    expect(blouse?.ruleGroupId).toBe("g2");
  });

  it("ignores unknown ids and empty collections", () => {
    const result = resolveSale(
      [
        group({
          id: "g1",
          targets: [
            { kind: "collection", id: "col-missing" },
            { kind: "collection", id: "col-empty" },
            { kind: "product", id: "p-missing" },
            { kind: "variant", id: "v-missing" },
          ],
        }),
      ],
      catalog,
    );
    expect(result).toEqual([]);
  });
});
