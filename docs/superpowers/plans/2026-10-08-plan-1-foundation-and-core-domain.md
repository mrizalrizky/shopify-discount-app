# Plan 1 — Foundation & Core Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Shopify app and build the pure, fully unit-tested domain core: money, rounding, sale-price calculation, rule-group resolution, sale-overlap detection, recurring-schedule expansion, and discount-code validation and generation.

**Architecture:** Shopify's official React Router app template (TypeScript) is the project shell. All domain logic lives in `app/domain/` as pure functions with no Shopify, database, or network access, so later plans (sale engine, code engine, billing) can call them from jobs and routes. Tests sit next to the code as `*.test.ts` and run with Vitest.

**Tech Stack:** TypeScript, Shopify CLI + React Router app template, Vitest, Luxon (timezones), Node `crypto` (code randomness).

**Spec:** `docs/superpowers/specs/2026-10-08-shopify-sale-and-codes-app-design.md`

**Roadmap (later plans, not in this document):**
- Plan 2 — Sale engine end to end: verification spikes (spec §11), Postgres/Prisma, pg-boss, apply/restore against Shopify, sale UI.
- Plan 3 — Code engine + Discount Function.
- Plan 4 — Billing, Home, uninstall handling, App Store readiness.

## Global Constraints

- Money is handled as **integer minor units** (1/100 of the shop currency). No floating-point money crosses a module boundary.
- A sale **never raises a price**: if the computed price is ≥ the current price, the variant is skipped (spec §5.3 step 5).
- Price base: `compareAt` is used only when `compareAt > price`; otherwise `price` (spec §5.3 step 1).
- Precedence inside a sale: **variant > product > collection**; between equal specificity, the lower `priority` number wins (spec §5.2).
- Schedules always use the **shop's timezone**, never the browser's (spec §5.6). Recurring windows may cross midnight.
- Discount codes are compared **case-insensitively** (Shopify treats codes case-insensitively); a code is never dropped without a reported reason (spec §6.3).
- Generated codes use cryptographic randomness (`node:crypto`), because single-use codes are worth money.
- Node.js 20 or 22 LTS.

## Review Focus

1. **Price would be zero or negative** (fixed amount off larger than the price, 100% off with no minimum, rounding below zero): the variant must be skipped with reason `non_positive`, never set to Rp0. → Task 2 tests.
2. **Bad compare-at data** (compare-at ≤ price): must fall back to `price` as the base, and the crossed-out price must still be higher than the new price. → Task 2 tests.
3. **Rounding to an ending** (e.g. "ends in 900") with an amount below the ending: must not wrap around or round up. → Tasks 1 and 2 tests.
4. **Recurring window crossing midnight on `lastDate`**, or a window already in progress at `from`: must be included. → Task 5 tests.
5. **Codes differing only by case or surrounding whitespace** (`summer10` vs ` SUMMER10 `): must be reported as duplicates, not sent to Shopify twice. → Task 6 tests.

---

## File Structure

```
app/domain/pricing/money.ts            Money type, parse/format Shopify decimal strings
app/domain/pricing/money.test.ts
app/domain/pricing/rounding.ts         RoundingRule + applyRounding (always rounds down)
app/domain/pricing/rounding.test.ts
app/domain/pricing/calculator.ts       calculateSalePrice: base → discount → rounding → min → skip rules
app/domain/pricing/calculator.test.ts
app/domain/sales/resolver.ts           resolveSale: rule groups + catalog index → variant assignments
app/domain/sales/resolver.test.ts
app/domain/sales/overlap.ts            findOverlaps across active/scheduled sales
app/domain/sales/overlap.test.ts
app/domain/schedule/recurring.ts       expandRecurring + shouldStartLate (Luxon)
app/domain/schedule/recurring.test.ts
app/domain/codes/validate.ts           codeKey + validateCodes
app/domain/codes/validate.test.ts
app/domain/codes/generate.ts           alphabet, capacity, needsLongerCodes, generateCodes
app/domain/codes/generate.test.ts
vitest.config.ts
```

---

### Task 1: Scaffold the app, set up tests, and add the money and rounding modules

**Files:**
- Create: project scaffold (Shopify CLI), `vitest.config.ts`
- Modify: `package.json` (add `test` script)
- Create: `app/domain/pricing/money.ts`, `app/domain/pricing/money.test.ts`
- Create: `app/domain/pricing/rounding.ts`, `app/domain/pricing/rounding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Money = number` (integer minor units)
  - `parseMoney(value: string): Money`
  - `formatMoney(amount: Money): string`
  - `type RoundingRule = { kind: "none" } | { kind: "roundDown"; step: Money } | { kind: "endsWith"; ending: Money; modulus: Money }`
  - `applyRounding(amount: Money, rule: RoundingRule): Money`

- [ ] **Step 1: Check Node version**

Run: `node -v`
Expected: `v20.x` or `v22.x`. If not, install Node 22 LTS before continuing.

- [ ] **Step 2: Scaffold the Shopify app**

From the project root (`shopify-discount-app/`), run:

```bash
npm init @shopify/app@latest
```

Answer the prompts:
- App name: `sale-codes-app`
- Template: **React Router** (the recommended option)
- Language: **TypeScript**

The CLI creates the folder `sale-codes-app/`. Move its contents into the project root, next to `docs/`. Drop any git repository the CLI created inside it, so the repo lives at the project root and includes `docs/`:

```bash
rm -rf sale-codes-app/.git && cp -r sale-codes-app/. . && rm -rf sale-codes-app
```

Expected: `package.json`, `app/`, `shopify.app.toml`, `prisma/` now sit in the project root.

- [ ] **Step 3: Initialise git and commit the untouched scaffold**

```bash
git init
git add -A
git commit -m "chore: scaffold Shopify React Router app"
```

- [ ] **Step 4: Install test and date dependencies**

```bash
npm install luxon
npm install -D vitest @types/luxon
```

- [ ] **Step 5: Add the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
```

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 6: Write the failing money tests**

Create `app/domain/pricing/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "./money";

describe("parseMoney", () => {
  it("parses Shopify decimal strings into minor units", () => {
    expect(parseMoney("149000.00")).toBe(14_900_000);
    expect(parseMoney("149000")).toBe(14_900_000);
    expect(parseMoney("149000.5")).toBe(14_900_050);
    expect(parseMoney(" 0.99 ")).toBe(99);
  });

  it("rejects invalid values", () => {
    expect(() => parseMoney("abc")).toThrow();
    expect(() => parseMoney("-1.00")).toThrow();
    expect(() => parseMoney("1.999")).toThrow();
    expect(() => parseMoney("")).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats minor units as a Shopify decimal string", () => {
    expect(formatMoney(14_900_050)).toBe("149000.50");
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(5)).toBe("0.05");
  });

  it("rejects negative or fractional amounts", () => {
    expect(() => formatMoney(-1)).toThrow();
    expect(() => formatMoney(1.5)).toThrow();
  });

  it("round-trips", () => {
    expect(parseMoney(formatMoney(12_345_678))).toBe(12_345_678);
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `npm test -- app/domain/pricing/money.test.ts`
Expected: FAIL — cannot resolve `./money`.

- [ ] **Step 8: Implement money**

Create `app/domain/pricing/money.ts`:

```ts
/** Integer amount in minor units (1/100 of the shop currency). */
export type Money = number;

const MONEY_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Parses a Shopify decimal string such as "149000.00" into minor units. */
export function parseMoney(value: string): Money {
  const match = MONEY_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid money value: "${value}"`);
  const units = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return units * 100 + cents;
}

/** Formats minor units as the decimal string Shopify's API expects. */
export function formatMoney(amount: Money): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Invalid money amount: ${amount}`);
  }
  const units = Math.floor(amount / 100);
  const cents = amount % 100;
  return `${units}.${String(cents).padStart(2, "0")}`;
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- app/domain/pricing/money.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Write the failing rounding tests**

Create `app/domain/pricing/rounding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyRounding } from "./rounding";

const RP = (rupiah: number) => rupiah * 100;

describe("applyRounding", () => {
  it("leaves the amount unchanged for 'none'", () => {
    expect(applyRounding(RP(149_250), { kind: "none" })).toBe(RP(149_250));
  });

  it("rounds down to a step", () => {
    const rule = { kind: "roundDown", step: RP(1_000) } as const;
    expect(applyRounding(RP(149_250), rule)).toBe(RP(149_000));
    expect(applyRounding(RP(149_000), rule)).toBe(RP(149_000));
    expect(applyRounding(RP(999), rule)).toBe(0);
  });

  it("rounds down to the nearest amount with the given ending", () => {
    const rule = { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } as const;
    expect(applyRounding(RP(149_250), rule)).toBe(RP(148_900));
    expect(applyRounding(RP(149_950), rule)).toBe(RP(149_900));
    expect(applyRounding(RP(149_900), rule)).toBe(RP(149_900));
  });

  it("never rounds up: an amount below the ending goes negative", () => {
    const rule = { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } as const;
    expect(applyRounding(RP(500), rule)).toBeLessThan(0);
  });

  it("rejects invalid rules", () => {
    expect(() => applyRounding(100, { kind: "roundDown", step: 0 })).toThrow();
    expect(() => applyRounding(100, { kind: "endsWith", ending: 1000, modulus: 1000 })).toThrow();
    expect(() => applyRounding(100, { kind: "endsWith", ending: -1, modulus: 1000 })).toThrow();
  });
});
```

- [ ] **Step 11: Run tests to verify they fail**

Run: `npm test -- app/domain/pricing/rounding.test.ts`
Expected: FAIL — cannot resolve `./rounding`.

- [ ] **Step 12: Implement rounding**

Create `app/domain/pricing/rounding.ts`:

```ts
import type { Money } from "./money";

export type RoundingRule =
  | { kind: "none" }
  | { kind: "roundDown"; step: Money }
  | { kind: "endsWith"; ending: Money; modulus: Money };

/**
 * Rounds an amount DOWN according to the rule. Rounding never increases a
 * price; callers must handle results that drop to zero or below.
 */
export function applyRounding(amount: Money, rule: RoundingRule): Money {
  switch (rule.kind) {
    case "none":
      return amount;
    case "roundDown":
      if (rule.step <= 0) throw new Error("roundDown step must be positive");
      return Math.floor(amount / rule.step) * rule.step;
    case "endsWith":
      if (rule.modulus <= 0 || rule.ending < 0 || rule.ending >= rule.modulus) {
        throw new Error("endsWith requires 0 <= ending < modulus");
      }
      return Math.floor((amount - rule.ending) / rule.modulus) * rule.modulus + rule.ending;
  }
}
```

- [ ] **Step 13: Run all tests**

Run: `npm test`
Expected: PASS (money + rounding).

- [ ] **Step 14: Commit**

```bash
git add vitest.config.ts package.json package-lock.json app/domain/pricing
git commit -m "feat: add Vitest, money and rounding domain modules"
```

---

### Task 2: Sale price calculator

**Files:**
- Create: `app/domain/pricing/calculator.ts`
- Test: `app/domain/pricing/calculator.test.ts`

**Interfaces:**
- Consumes: `Money`, `RoundingRule`, `applyRounding` (Task 1).
- Produces:
  - `type AmountType = "percentOff" | "fixedOff" | "fixedPrice"`
  - `interface Discount { type: AmountType; amount: number }` — percent (0 < x ≤ 100) for `percentOff`, otherwise `Money`
  - `type PriceBase = "compareAt" | "current"`
  - `interface VariantPrice { price: Money; compareAt: Money | null }`
  - `interface PricingOptions { priceBase: PriceBase; rounding: RoundingRule; minPrice: Money | null }`
  - `type SkipReason = "not_lower" | "non_positive"`
  - `type PriceResult = { ok: true; newPrice: Money; newCompareAt: Money } | { ok: false; reason: SkipReason }`
  - `calculateSalePrice(variant: VariantPrice, discount: Discount, options: PricingOptions): PriceResult`

- [ ] **Step 1: Write the failing tests**

Create `app/domain/pricing/calculator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculateSalePrice, type PricingOptions } from "./calculator";

const RP = (rupiah: number) => rupiah * 100;
const plain: PricingOptions = { priceBase: "compareAt", rounding: { kind: "none" }, minPrice: null };

describe("calculateSalePrice", () => {
  it("takes 30% off the compare-at price when priceBase is compareAt", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(500_000) },
      { type: "percentOff", amount: 30 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(350_000), newCompareAt: RP(500_000) });
  });

  it("takes 30% off the current price when priceBase is current", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(500_000) },
      { type: "percentOff", amount: 30 },
      { ...plain, priceBase: "current" },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(280_000), newCompareAt: RP(500_000) });
  });

  it("uses the price as crossed-out price when there is no compare-at", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 20 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(160_000), newCompareAt: RP(200_000) });
  });

  it("ignores a compare-at that is not above the price (bad data)", () => {
    const result = calculateSalePrice(
      { price: RP(400_000), compareAt: RP(350_000) },
      { type: "percentOff", amount: 50 },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(200_000), newCompareAt: RP(400_000) });
  });

  it("applies a fixed amount off", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "fixedOff", amount: RP(50_000) },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(150_000), newCompareAt: RP(200_000) });
  });

  it("sets a fixed final price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "fixedPrice", amount: RP(99_000) },
      plain,
    );
    expect(result).toEqual({ ok: true, newPrice: RP(99_000), newCompareAt: RP(200_000) });
  });

  it("rounds after discounting", () => {
    const result = calculateSalePrice(
      { price: RP(149_900), compareAt: null },
      { type: "percentOff", amount: 30 },
      { ...plain, rounding: { kind: "roundDown", step: RP(1_000) } },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(104_000), newCompareAt: RP(149_900) });
  });

  it("raises the result to the minimum price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 90 },
      { ...plain, minPrice: RP(50_000) },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(50_000), newCompareAt: RP(200_000) });
  });

  it("supports 100% off plus a minimum price as a fixed sale price", () => {
    const result = calculateSalePrice(
      { price: RP(200_000), compareAt: null },
      { type: "percentOff", amount: 100 },
      { ...plain, minPrice: RP(99_000) },
    );
    expect(result).toEqual({ ok: true, newPrice: RP(99_000), newCompareAt: RP(200_000) });
  });

  describe("skip rules", () => {
    it("skips when a fixed price is not lower than the current price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "fixedPrice", amount: RP(250_000) },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when a discount off compare-at is still above the current price", () => {
      const result = calculateSalePrice(
        { price: RP(400_000), compareAt: RP(500_000) },
        { type: "percentOff", amount: 10 },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when the minimum price is not lower than the current price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "percentOff", amount: 50 },
        { ...plain, minPrice: RP(250_000) },
      );
      expect(result).toEqual({ ok: false, reason: "not_lower" });
    });

    it("skips when a fixed amount off exceeds the price", () => {
      const result = calculateSalePrice(
        { price: RP(40_000), compareAt: null },
        { type: "fixedOff", amount: RP(50_000) },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });

    it("skips 100% off without a minimum price", () => {
      const result = calculateSalePrice(
        { price: RP(200_000), compareAt: null },
        { type: "percentOff", amount: 100 },
        plain,
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });

    it("skips when rounding to an ending drops below zero", () => {
      const result = calculateSalePrice(
        { price: RP(1_000), compareAt: null },
        { type: "percentOff", amount: 50 },
        { ...plain, rounding: { kind: "endsWith", ending: RP(900), modulus: RP(1_000) } },
      );
      expect(result).toEqual({ ok: false, reason: "non_positive" });
    });
  });

  describe("input validation", () => {
    it("rejects a percentage outside (0, 100]", () => {
      const v = { price: RP(100_000), compareAt: null };
      expect(() => calculateSalePrice(v, { type: "percentOff", amount: 0 }, plain)).toThrow();
      expect(() => calculateSalePrice(v, { type: "percentOff", amount: 101 }, plain)).toThrow();
    });

    it("rejects negative or fractional money amounts", () => {
      const v = { price: RP(100_000), compareAt: null };
      expect(() => calculateSalePrice(v, { type: "fixedOff", amount: -1 }, plain)).toThrow();
      expect(() => calculateSalePrice(v, { type: "fixedPrice", amount: 1.5 }, plain)).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/pricing/calculator.test.ts`
Expected: FAIL — cannot resolve `./calculator`.

- [ ] **Step 3: Implement the calculator**

Create `app/domain/pricing/calculator.ts`:

```ts
import type { Money } from "./money";
import { applyRounding, type RoundingRule } from "./rounding";

export type AmountType = "percentOff" | "fixedOff" | "fixedPrice";

/** `amount` is a percentage (0 < x <= 100) for percentOff, otherwise Money. */
export interface Discount {
  type: AmountType;
  amount: number;
}

export type PriceBase = "compareAt" | "current";

export interface VariantPrice {
  price: Money;
  compareAt: Money | null;
}

export interface PricingOptions {
  priceBase: PriceBase;
  rounding: RoundingRule;
  minPrice: Money | null;
}

export type SkipReason = "not_lower" | "non_positive";

export type PriceResult =
  | { ok: true; newPrice: Money; newCompareAt: Money }
  | { ok: false; reason: SkipReason };

export function calculateSalePrice(
  variant: VariantPrice,
  discount: Discount,
  options: PricingOptions,
): PriceResult {
  validateDiscount(discount);

  const hasValidCompareAt = variant.compareAt !== null && variant.compareAt > variant.price;
  const base =
    options.priceBase === "compareAt" && hasValidCompareAt ? variant.compareAt! : variant.price;

  let newPrice = applyRounding(discountedAmount(base, discount), options.rounding);
  if (options.minPrice !== null && newPrice < options.minPrice) newPrice = options.minPrice;

  if (newPrice <= 0) return { ok: false, reason: "non_positive" };
  if (newPrice >= variant.price) return { ok: false, reason: "not_lower" };

  const newCompareAt = hasValidCompareAt ? variant.compareAt! : variant.price;
  return { ok: true, newPrice, newCompareAt };
}

function discountedAmount(base: Money, discount: Discount): Money {
  switch (discount.type) {
    case "percentOff":
      return Math.round((base * (100 - discount.amount)) / 100);
    case "fixedOff":
      return base - discount.amount;
    case "fixedPrice":
      return discount.amount;
  }
}

function validateDiscount(discount: Discount): void {
  if (discount.type === "percentOff") {
    if (!(discount.amount > 0 && discount.amount <= 100)) {
      throw new Error(`Percentage must be in (0, 100], got ${discount.amount}`);
    }
    return;
  }
  if (!Number.isInteger(discount.amount) || discount.amount < 0) {
    throw new Error(`Money amount must be a non-negative integer, got ${discount.amount}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/pricing/calculator.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add app/domain/pricing/calculator.ts app/domain/pricing/calculator.test.ts
git commit -m "feat: add sale price calculator with skip rules"
```

---

### Task 3: Rule-group resolver

**Files:**
- Create: `app/domain/sales/resolver.ts`
- Test: `app/domain/sales/resolver.test.ts`

**Interfaces:**
- Consumes: `Discount` (Task 2).
- Produces:
  - `type TargetKind = "collection" | "product" | "variant"`
  - `interface Target { kind: TargetKind; id: string }`
  - `interface RuleGroupInput { id: string; priority: number; discount: Discount; targets: Target[]; exclusions: Target[] }`
  - `interface CatalogIndex { collectionProducts: ReadonlyMap<string, readonly string[]>; productVariants: ReadonlyMap<string, readonly string[]> }`
  - `interface ResolvedVariant { variantId: string; productId: string; ruleGroupId: string }`
  - `resolveSale(groups: readonly RuleGroupInput[], catalog: CatalogIndex): ResolvedVariant[]` (sorted by `variantId`)

- [ ] **Step 1: Write the failing tests**

Create `app/domain/sales/resolver.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/sales/resolver.test.ts`
Expected: FAIL — cannot resolve `./resolver`.

- [ ] **Step 3: Implement the resolver**

Create `app/domain/sales/resolver.ts`:

```ts
import type { Discount } from "../pricing/calculator";

export type TargetKind = "collection" | "product" | "variant";

export interface Target {
  kind: TargetKind;
  id: string;
}

export interface RuleGroupInput {
  id: string;
  priority: number;
  discount: Discount;
  targets: Target[];
  exclusions: Target[];
}

/** Catalog membership fetched from Shopify before resolution. */
export interface CatalogIndex {
  collectionProducts: ReadonlyMap<string, readonly string[]>;
  productVariants: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedVariant {
  variantId: string;
  productId: string;
  ruleGroupId: string;
}

const SPECIFICITY: Record<TargetKind, number> = { collection: 1, product: 2, variant: 3 };

interface Claim {
  groupIndex: number;
  specificity: number;
  priority: number;
}

/**
 * Assigns each targeted variant to exactly one rule group.
 * Precedence: variant > product > collection, then lower priority number,
 * then earlier group.
 */
export function resolveSale(
  groups: readonly RuleGroupInput[],
  catalog: CatalogIndex,
): ResolvedVariant[] {
  const productOf = new Map<string, string>();
  for (const [productId, variantIds] of catalog.productVariants) {
    for (const variantId of variantIds) productOf.set(variantId, productId);
  }

  const claims = new Map<string, Claim>();
  groups.forEach((group, groupIndex) => {
    const excluded = new Set(group.exclusions.flatMap((t) => expandTarget(t, catalog)));
    for (const target of group.targets) {
      const claim = { groupIndex, specificity: SPECIFICITY[target.kind], priority: group.priority };
      for (const variantId of expandTarget(target, catalog)) {
        if (excluded.has(variantId) || !productOf.has(variantId)) continue;
        const current = claims.get(variantId);
        if (!current || beats(claim, current)) claims.set(variantId, claim);
      }
    }
  });

  return [...claims]
    .map(([variantId, claim]) => ({
      variantId,
      productId: productOf.get(variantId)!,
      ruleGroupId: groups[claim.groupIndex].id,
    }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
}

function beats(a: Claim, b: Claim): boolean {
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.groupIndex < b.groupIndex;
}

function expandTarget(target: Target, catalog: CatalogIndex): string[] {
  switch (target.kind) {
    case "variant":
      return [target.id];
    case "product":
      return [...(catalog.productVariants.get(target.id) ?? [])];
    case "collection":
      return (catalog.collectionProducts.get(target.id) ?? []).flatMap(
        (productId) => catalog.productVariants.get(productId) ?? [],
      );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/sales/resolver.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/domain/sales
git commit -m "feat: add rule-group resolver with specificity precedence"
```

---

### Task 4: Cross-sale overlap detection

**Files:**
- Create: `app/domain/sales/overlap.ts`
- Test: `app/domain/sales/overlap.test.ts`

**Interfaces:**
- Consumes: nothing (variant ID strings, as produced by `resolveSale` in Task 3).
- Produces:
  - `interface SaleVariants { saleId: string; variantIds: ReadonlySet<string> }`
  - `interface Overlap { saleId: string; variantIds: string[] }`
  - `findOverlaps(candidateVariantIds: Iterable<string>, otherSales: readonly SaleVariants[]): Overlap[]`

v1 rule (spec §5.2): a variant may belong to only one active **or scheduled** sale. Time windows are deliberately ignored, which is the conservative choice.

- [ ] **Step 1: Write the failing tests**

Create `app/domain/sales/overlap.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/sales/overlap.test.ts`
Expected: FAIL — cannot resolve `./overlap`.

- [ ] **Step 3: Implement overlap detection**

Create `app/domain/sales/overlap.ts`:

```ts
export interface SaleVariants {
  saleId: string;
  variantIds: ReadonlySet<string>;
}

export interface Overlap {
  saleId: string;
  variantIds: string[];
}

/** v1: a variant may belong to only one active or scheduled sale. */
export function findOverlaps(
  candidateVariantIds: Iterable<string>,
  otherSales: readonly SaleVariants[],
): Overlap[] {
  const candidates = [...new Set(candidateVariantIds)];
  return otherSales
    .map((sale) => ({
      saleId: sale.saleId,
      variantIds: candidates.filter((id) => sale.variantIds.has(id)).sort(),
    }))
    .filter((overlap) => overlap.variantIds.length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/sales/overlap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/domain/sales/overlap.ts app/domain/sales/overlap.test.ts
git commit -m "feat: add cross-sale overlap detection"
```

---

### Task 5: Recurring schedule expansion

**Files:**
- Create: `app/domain/schedule/recurring.ts`
- Test: `app/domain/schedule/recurring.test.ts`

**Interfaces:**
- Consumes: `luxon` (installed in Task 1).
- Produces:
  - `interface RecurringSchedule { weekdays: number[]; startTime: string; stopTime: string; firstDate: string; lastDate: string }`. `weekdays` uses ISO numbering (1 = Monday … 7 = Sunday); times are `"HH:mm"`; dates are `"YYYY-MM-DD"`. `lastDate` is the last date a window may **start** on.
  - `interface TimeWindow { start: Date; end: Date }`
  - `expandRecurring(schedule: RecurringSchedule, timezone: string, from: Date, to: Date): TimeWindow[]` returns windows that overlap `[from, to)`, sorted by start.
  - `shouldStartLate(window: TimeWindow, now: Date): boolean` (spec §5.6: apply late only while the window is open)

Calendar facts used below: 2026-11-06 is a Friday; 2026-03-01 and 2026-03-08 are Sundays; US DST starts 2026-03-08. Asia/Jakarta is UTC+7 with no DST.

- [ ] **Step 1: Write the failing tests**

Create `app/domain/schedule/recurring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expandRecurring, shouldStartLate, type RecurringSchedule } from "./recurring";

const JAKARTA = "Asia/Jakarta";
const iso = (d: Date) => d.toISOString();
const span = (w: { start: Date; end: Date }) => [iso(w.start), iso(w.end)];

const fridaySaturdayEvenings: RecurringSchedule = {
  weekdays: [5, 6],
  startTime: "19:00",
  stopTime: "23:00",
  firstDate: "2026-11-06",
  lastDate: "2026-11-14",
};

describe("expandRecurring", () => {
  it("creates one window per selected weekday in the shop timezone", () => {
    const windows = expandRecurring(
      fridaySaturdayEvenings,
      JAKARTA,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-12-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-11-06T12:00:00.000Z", "2026-11-06T16:00:00.000Z"],
      ["2026-11-07T12:00:00.000Z", "2026-11-07T16:00:00.000Z"],
      ["2026-11-13T12:00:00.000Z", "2026-11-13T16:00:00.000Z"],
      ["2026-11-14T12:00:00.000Z", "2026-11-14T16:00:00.000Z"],
    ]);
  });

  it("handles windows that cross midnight, including one starting on lastDate", () => {
    const windows = expandRecurring(
      { weekdays: [5], startTime: "22:00", stopTime: "02:00", firstDate: "2026-11-06", lastDate: "2026-11-13" },
      JAKARTA,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-12-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-11-06T15:00:00.000Z", "2026-11-06T19:00:00.000Z"],
      ["2026-11-13T15:00:00.000Z", "2026-11-13T19:00:00.000Z"],
    ]);
  });

  it("includes a window already in progress at 'from' and excludes ones outside the range", () => {
    const windows = expandRecurring(
      fridaySaturdayEvenings,
      JAKARTA,
      new Date("2026-11-07T14:00:00Z"), // mid-way through Saturday's window
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([["2026-11-07T12:00:00.000Z", "2026-11-07T16:00:00.000Z"]]);
  });

  it("includes an overnight window from the previous day still open at 'from'", () => {
    const windows = expandRecurring(
      { weekdays: [5], startTime: "22:00", stopTime: "02:00", firstDate: "2026-11-06", lastDate: "2026-11-06" },
      JAKARTA,
      new Date("2026-11-06T18:00:00Z"), // 01:00 WIB on Saturday
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([["2026-11-06T15:00:00.000Z", "2026-11-06T19:00:00.000Z"]]);
  });

  it("follows daylight-saving changes in zones that have them", () => {
    const windows = expandRecurring(
      { weekdays: [7], startTime: "09:00", stopTime: "17:00", firstDate: "2026-03-01", lastDate: "2026-03-08" },
      "America/New_York",
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(windows.map(span)).toEqual([
      ["2026-03-01T14:00:00.000Z", "2026-03-01T22:00:00.000Z"], // EST, UTC-5
      ["2026-03-08T13:00:00.000Z", "2026-03-08T21:00:00.000Z"], // EDT, UTC-4
    ]);
  });

  it("rejects invalid schedules", () => {
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2026-12-01T00:00:00Z");
    const bad = (patch: Partial<RecurringSchedule>) =>
      expandRecurring({ ...fridaySaturdayEvenings, ...patch }, JAKARTA, from, to);
    expect(() => bad({ startTime: "19:00", stopTime: "19:00" })).toThrow();
    expect(() => bad({ lastDate: "2026-11-01" })).toThrow();
    expect(() => bad({ weekdays: [0] })).toThrow();
    expect(() => bad({ weekdays: [] })).toThrow();
    expect(() => bad({ startTime: "25:00" })).toThrow();
    expect(() => bad({ firstDate: "2026-13-01" })).toThrow();
  });
});

describe("shouldStartLate", () => {
  const window = { start: new Date("2026-11-06T12:00:00Z"), end: new Date("2026-11-06T16:00:00Z") };

  it("is true while the window is open", () => {
    expect(shouldStartLate(window, new Date("2026-11-06T12:00:00Z"))).toBe(true);
    expect(shouldStartLate(window, new Date("2026-11-06T15:59:00Z"))).toBe(true);
  });

  it("is false before the start or once the window has ended", () => {
    expect(shouldStartLate(window, new Date("2026-11-06T11:59:00Z"))).toBe(false);
    expect(shouldStartLate(window, new Date("2026-11-06T16:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/schedule/recurring.test.ts`
Expected: FAIL — cannot resolve `./recurring`.

- [ ] **Step 3: Implement schedule expansion**

Create `app/domain/schedule/recurring.ts`:

```ts
import { DateTime } from "luxon";

export interface RecurringSchedule {
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  /** "HH:mm" in the shop timezone. */
  startTime: string;
  /** "HH:mm"; at or before startTime means the window ends the next day. */
  stopTime: string;
  /** "YYYY-MM-DD": first date a window may start on. */
  firstDate: string;
  /** "YYYY-MM-DD": last date a window may start on (inclusive). */
  lastDate: string;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** Returns the windows that overlap [from, to), sorted by start. */
export function expandRecurring(
  schedule: RecurringSchedule,
  timezone: string,
  from: Date,
  to: Date,
): TimeWindow[] {
  const start = parseTime(schedule.startTime);
  const stop = parseTime(schedule.stopTime);
  const startMinutes = start.hour * 60 + start.minute;
  const stopMinutes = stop.hour * 60 + stop.minute;
  if (startMinutes === stopMinutes) throw new Error("startTime and stopTime must differ");
  const crossesMidnight = stopMinutes < startMinutes;

  if (schedule.weekdays.length === 0) throw new Error("Select at least one weekday");
  for (const day of schedule.weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error(`Invalid weekday: ${day}`);
  }

  const firstDate = parseDate(schedule.firstDate, timezone);
  const lastDate = parseDate(schedule.lastDate, timezone);
  if (lastDate < firstDate) throw new Error("lastDate must not be before firstDate");

  // Start one day early so an overnight window that began yesterday is found.
  const scanFrom = DateTime.fromJSDate(from, { zone: timezone }).startOf("day").minus({ days: 1 });
  const scanTo = DateTime.fromJSDate(to, { zone: timezone }).startOf("day");
  let day = DateTime.max(firstDate, scanFrom);
  const lastDay = DateTime.min(lastDate, scanTo);

  const windows: TimeWindow[] = [];
  while (day <= lastDay) {
    if (schedule.weekdays.includes(day.weekday)) {
      const windowStart = day.set({ ...start, second: 0, millisecond: 0 });
      const windowEnd = (crossesMidnight ? day.plus({ days: 1 }) : day).set({
        ...stop,
        second: 0,
        millisecond: 0,
      });
      const startDate = windowStart.toJSDate();
      const endDate = windowEnd.toJSDate();
      if (endDate > from && startDate < to) windows.push({ start: startDate, end: endDate });
    }
    day = day.plus({ days: 1 });
  }
  return windows;
}

/** A missed start is applied only while its window is still open. */
export function shouldStartLate(window: TimeWindow, now: Date): boolean {
  return now >= window.start && now < window.end;
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:mm`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseDate(value: string, timezone: string): DateTime {
  const date = DateTime.fromISO(value, { zone: timezone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid) {
    throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  return date.startOf("day");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/schedule/recurring.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/domain/schedule
git commit -m "feat: add recurring schedule expansion in shop timezone"
```

---

### Task 6: Discount code validation

**Files:**
- Create: `app/domain/codes/validate.ts`
- Test: `app/domain/codes/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_CODE_LENGTH = 255`
  - `codeKey(code: string): string` (trimmed and upper-cased; the comparison key)
  - `type CodeIssueReason = "contains_whitespace" | "too_long" | "duplicate_in_list" | "already_exists"`
  - `interface CodeIssue { code: string; reason: CodeIssueReason }`
  - `validateCodes(raw: readonly string[], existingKeys: ReadonlySet<string>): { valid: string[]; issues: CodeIssue[] }`

Blank lines are skipped silently (common in pasted lists). Valid codes keep the merchant's casing, trimmed.

- [ ] **Step 1: Write the failing tests**

Create `app/domain/codes/validate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/codes/validate.test.ts`
Expected: FAIL — cannot resolve `./validate`.

- [ ] **Step 3: Implement validation**

Create `app/domain/codes/validate.ts`:

```ts
export const MAX_CODE_LENGTH = 255;

export type CodeIssueReason =
  | "contains_whitespace"
  | "too_long"
  | "duplicate_in_list"
  | "already_exists";

export interface CodeIssue {
  code: string;
  reason: CodeIssueReason;
}

/** Shopify treats discount codes case-insensitively; compare on this key. */
export function codeKey(code: string): string {
  return code.trim().toUpperCase();
}

export function validateCodes(
  raw: readonly string[],
  existingKeys: ReadonlySet<string>,
): { valid: string[]; issues: CodeIssue[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const issues: CodeIssue[] = [];

  for (const entry of raw) {
    const code = entry.trim();
    if (code === "") continue;
    if (/\s/.test(code)) {
      issues.push({ code, reason: "contains_whitespace" });
      continue;
    }
    if (code.length > MAX_CODE_LENGTH) {
      issues.push({ code, reason: "too_long" });
      continue;
    }
    const key = codeKey(code);
    if (seen.has(key)) {
      issues.push({ code, reason: "duplicate_in_list" });
    } else if (existingKeys.has(key)) {
      issues.push({ code, reason: "already_exists" });
    } else {
      seen.add(key);
      valid.push(code);
    }
  }
  return { valid, issues };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/codes/validate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/domain/codes/validate.ts app/domain/codes/validate.test.ts
git commit -m "feat: add case-insensitive discount code validation"
```

---

### Task 7: Random discount code generator

**Files:**
- Create: `app/domain/codes/generate.ts`
- Test: `app/domain/codes/generate.test.ts`

**Interfaces:**
- Consumes: `codeKey`, `MAX_CODE_LENGTH` (Task 6).
- Produces:
  - `interface GeneratorOptions { prefix: string; length: number; charset: "letters" | "numbers" | "both"; excludeLookalikes: boolean }`
  - `codeAlphabet(options: GeneratorOptions): string`
  - `codeCapacity(options: GeneratorOptions): number` (`alphabet.length ** length`)
  - `needsLongerCodes(count: number, options: GeneratorOptions): boolean` (true when `count` exceeds 10% of capacity, where collisions start slowing generation and codes become guessable)
  - `generateCodes(count: number, options: GeneratorOptions, existingKeys: ReadonlySet<string>, randomInt?: (max: number) => number): string[]`. Defaults to `crypto.randomInt`. Throws if it cannot produce `count` unique codes.

- [ ] **Step 1: Write the failing tests**

Create `app/domain/codes/generate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  codeAlphabet,
  codeCapacity,
  generateCodes,
  needsLongerCodes,
  type GeneratorOptions,
} from "./generate";

const base: GeneratorOptions = { prefix: "GDI23-OL", length: 3, charset: "both", excludeLookalikes: false };

/** Deterministic randomInt that walks 0, 1, 2, ... modulo max. */
function sequence() {
  let next = 0;
  return (max: number) => next++ % max;
}

describe("codeAlphabet / codeCapacity", () => {
  it("builds the alphabet for each charset", () => {
    expect(codeAlphabet({ ...base, charset: "letters" })).toHaveLength(26);
    expect(codeAlphabet({ ...base, charset: "numbers" })).toBe("0123456789");
    expect(codeAlphabet(base)).toHaveLength(36);
  });

  it("removes look-alike characters", () => {
    const alphabet = codeAlphabet({ ...base, excludeLookalikes: true });
    expect(alphabet).toHaveLength(31);
    for (const ch of "0O1IL") expect(alphabet).not.toContain(ch);
  });

  it("computes capacity", () => {
    expect(codeCapacity(base)).toBe(36 ** 3);
    expect(codeCapacity({ ...base, charset: "letters" })).toBe(17_576);
  });
});

describe("needsLongerCodes", () => {
  it("warns when the request is more than 10% of capacity", () => {
    expect(needsLongerCodes(500, base)).toBe(false); // capacity 46,656
    expect(needsLongerCodes(10_000, base)).toBe(true);
  });
});

describe("generateCodes", () => {
  it("generates the requested number of unique, prefixed codes", () => {
    const codes = generateCodes(500, base, new Set());
    expect(codes).toHaveLength(500);
    expect(new Set(codes).size).toBe(500);
    for (const code of codes) expect(code).toMatch(/^GDI23-OL[A-Z0-9]{3}$/);
  });

  it("never uses look-alike characters when excluded", () => {
    const codes = generateCodes(300, { ...base, prefix: "", length: 6, excludeLookalikes: true }, new Set());
    for (const code of codes) expect(code).not.toMatch(/[0O1IL]/);
  });

  it("skips codes that already exist, case-insensitively", () => {
    const options: GeneratorOptions = { prefix: "p", length: 1, charset: "numbers", excludeLookalikes: false };
    const existing = new Set(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
    expect(generateCodes(1, options, existing, sequence())).toEqual(["p9"]);
  });

  it("throws when the requested count exceeds the available combinations", () => {
    const options: GeneratorOptions = { prefix: "X", length: 1, charset: "numbers", excludeLookalikes: false };
    expect(() => generateCodes(11, options, new Set())).toThrow(/longer/);
    expect(() => generateCodes(2, options, new Set(["X0", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8"]))).toThrow(
      /longer/,
    );
  });

  it("rejects invalid options", () => {
    expect(() => generateCodes(1, { ...base, length: 0 }, new Set())).toThrow();
    expect(() => generateCodes(1, { ...base, prefix: "HAS SPACE" }, new Set())).toThrow();
    expect(() => generateCodes(1, { ...base, prefix: "A".repeat(254), length: 3 }, new Set())).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/domain/codes/generate.test.ts`
Expected: FAIL — cannot resolve `./generate`.

- [ ] **Step 3: Implement the generator**

Create `app/domain/codes/generate.ts`:

```ts
import { randomInt as cryptoRandomInt } from "node:crypto";
import { codeKey, MAX_CODE_LENGTH } from "./validate";

export interface GeneratorOptions {
  prefix: string;
  /** Length of the random part. */
  length: number;
  charset: "letters" | "numbers" | "both";
  excludeLookalikes: boolean;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const LOOKALIKES = new Set(["0", "O", "1", "I", "L"]);
const MAX_ATTEMPTS_PER_CODE = 50;

export function codeAlphabet(options: GeneratorOptions): string {
  const chars =
    options.charset === "letters" ? LETTERS : options.charset === "numbers" ? DIGITS : LETTERS + DIGITS;
  return options.excludeLookalikes ? [...chars].filter((c) => !LOOKALIKES.has(c)).join("") : chars;
}

export function codeCapacity(options: GeneratorOptions): number {
  return codeAlphabet(options).length ** options.length;
}

/** Above 10% of capacity, collisions slow generation and codes get guessable. */
export function needsLongerCodes(count: number, options: GeneratorOptions): boolean {
  return count > codeCapacity(options) * 0.1;
}

export function generateCodes(
  count: number,
  options: GeneratorOptions,
  existingKeys: ReadonlySet<string>,
  randomInt: (max: number) => number = cryptoRandomInt,
): string[] {
  validateOptions(options);
  const alphabet = codeAlphabet(options);
  const prefixKey = codeKey(options.prefix);
  const takenWithPrefix = [...existingKeys].filter(
    (key) => key.length === prefixKey.length + options.length && key.startsWith(prefixKey),
  ).length;
  if (count > codeCapacity(options) - takenWithPrefix) {
    throw new Error("Not enough unique combinations; use a longer random part");
  }

  const used = new Set(existingKeys);
  const codes: string[] = [];
  const maxAttempts = Math.max(count, 1) * MAX_ATTEMPTS_PER_CODE;
  let attempts = 0;

  while (codes.length < count) {
    if (++attempts > maxAttempts) {
      throw new Error("Could not generate enough unique codes; use a longer random part");
    }
    let random = "";
    for (let i = 0; i < options.length; i++) random += alphabet[randomInt(alphabet.length)];
    const code = options.prefix + random;
    const key = codeKey(code);
    if (used.has(key)) continue;
    used.add(key);
    codes.push(code);
  }
  return codes;
}

function validateOptions(options: GeneratorOptions): void {
  if (!Number.isInteger(options.length) || options.length < 1) {
    throw new Error("Random part length must be at least 1");
  }
  if (/\s/.test(options.prefix)) throw new Error("Prefix must not contain whitespace");
  if (options.prefix.length + options.length > MAX_CODE_LENGTH) {
    throw new Error(`Codes must be at most ${MAX_CODE_LENGTH} characters`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app/domain/codes/generate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the whole suite and the type checker**

Run: `npm test`
Expected: PASS (all domain tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/domain/codes/generate.ts app/domain/codes/generate.test.ts
git commit -m "feat: add secure random discount code generator"
```

---

## Spec coverage (Plan 1 only)

| Spec section | Covered by |
|---|---|
| §3 Tech stack (template, TypeScript, Vitest) | Task 1 |
| §5.2 Targeting, precedence, exclusions | Task 3 |
| §5.2 One active/scheduled sale per variant | Task 4 |
| §5.3 Price calculation, rounding, min price, skip rule | Tasks 1, 2 |
| §5.6 Recurring schedules, timezone, midnight, missed starts | Task 5 |
| §6.3 Code validation (duplicates, existing) | Task 6 |
| §6.4 Random generator (prefix, length, charset, look-alikes, collisions, capacity warning) | Task 7 |
| §4, §5.1, §5.4–5.5, §5.7, §6.1–6.2, §6.5–6.7, §7–§11 | Plans 2–4 |
