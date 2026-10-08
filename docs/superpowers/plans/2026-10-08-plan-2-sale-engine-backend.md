# Plan 2 — Sale Engine Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sales actually run against a Shopify store: Postgres persistence, price snapshots, safe apply/restore with crash recovery, product tags, auto-refresh, and a pg-boss worker that starts and stops sales on schedule.

**Architecture:** Services in `app/sales/` take a `PrismaClient` and a `ShopifyGateway` (interface) as parameters. Production uses a GraphQL implementation of the gateway; tests use an in-memory `FakeShopify`, so every safety rule is tested without a real store. Pure planning and scheduling logic lives in `app/domain/` next to Plan 1's modules. A separate worker process (`npm run worker`) runs pg-boss jobs: a one-minute tick that decides what is due, plus start/stop/refresh jobs per sale run.

**Tech Stack:** TypeScript, Prisma 6 + PostgreSQL 17 (Docker), pg-boss 10, Shopify Admin GraphQL API (2025-10 via the template), Vitest (unit + integration configs), tsx (worker and scripts), Luxon.

**Spec:** `docs/superpowers/specs/2026-10-08-shopify-sale-and-codes-app-design.md`

**Roadmap (revised — sale UI split out of this plan):**
- Plan 1 — Foundation & core domain ✅ merged
- **Plan 2 — Sale engine backend (this plan)**
- Plan 3 — Sale admin UI (editor, preview, detail, conflict resolution, `products/update` early-conflict webhook)
- Plan 4 — Code engine + Discount Function (starts with spikes §11.1 and §11.3)
- Plan 5 — Billing, Home, uninstall handling, notifications, App Store readiness

## Global Constraints

- Money is **integer minor units** in code and **`BigInt` columns** in Postgres; convert only through `app/sales/money-db.ts`.
- **Snapshots are written in one DB transaction, with a count check, before any Shopify write** (spec §5.4 steps 2–3).
- **Every Shopify price write for a sale also sets the `$app:sale_state` variant metafield** (marker + copy of original prices, spec §5.4 step 4).
- **Retries never apply twice and never report false conflicts:** before writing, compare Shopify's current state against the snapshot (spec §5.4 step 6, §5.5).
- **A price changed by someone else is never overwritten silently** — mark the snapshot `CONFLICT` (spec §5.5).
- A variant may be in only one active sale at a time (spec §5.2).
- Tags the product **already had** before the sale are never removed at restore, and tags the sale removed are put back.
- Schedules use the sale's stored shop timezone (spec §5.6).
- Shopify API version comes from `app/shopify.server.ts` (`ApiVersion.October25`); do not hard-code another.

## Deliberate deviations from the spec (decided while planning)

1. **Bulk mutation operations for >1,000 variants (spec §5.4 step 4) are deferred.** All sizes use `productVariantsBulkUpdate` per product with throttle-aware retries. Task 11 measures a 1,000+ variant sale on the dev store; if it is too slow, bulk operations become a follow-up task.
2. **`products/update` webhook for early conflict detection (spec §4, §9) moves to Plan 3**, because only the UI consumes it. Conflicts are still detected reliably at restore time in this plan.
3. **The metafield fallback (spec §5.5)** is implemented as `recoverFromMetafields()`; wiring it to the reinstall flow is Plan 5, after the uninstall spike (Task 11) confirms whether metafields survive.
4. **Job failure notifications (spec §9)** are Plan 5. Here, failures are recorded on `SaleRun.error` and retried by pg-boss.

## Review Focus

1. **Crash between a Shopify write and the DB update** (during apply or restore): a retry must neither write twice, nor log twice, nor mark the variant as a conflict. → Tasks 6, 7 tests.
2. **Merchant edits a price between snapshot and apply:** the variant must become `CONFLICT` and keep the merchant's price. → Task 6 test.
3. **Product already had a tag the sale adds** (e.g. `sale`): restore must not remove it. → Tasks 6, 7 tests.
4. **The tick runs twice for the same window** (overlapping ticks or a slow worker): only one `SaleRun` per window. → Task 10 test.
5. **Variant deleted from Shopify during a sale:** restore must finish and mark it `RESTORED`, not crash the run. → Task 7 test.

---

## File Structure

```
docker-compose.yml                       Postgres 17 for dev + test databases
docker/init-test-db.sql                  creates salecodes_test
example.env                              documented env vars (copy to .env)
prisma/schema.prisma                     Postgres provider + sale models
vitest.config.ts                         unit tests (excludes *.int.test.ts)
vitest.integration.config.ts             integration tests against salecodes_test
test/integration-setup.ts                migrate-reset the test DB once
test/db.ts                               testDb client + resetDb()
test/factories.ts                        createSale / createRun helpers
test/fake-shopify.ts                     in-memory ShopifyGateway
app/domain/sales/plan.ts                 computeSalePlan (pure)
app/domain/schedule/due.ts               dueActions (pure)
app/sales/money-db.ts                    BigInt <-> Money
app/sales/load.ts                        DB sale -> domain inputs, planForSale, toSnapshotRow
app/sales/prepare.ts                     prepareRun
app/sales/apply.ts                       applyRun (+ tags)
app/sales/restore.ts                     restoreRun, restoreSnapshots, resolveConflict, recoverFromMetafields
app/sales/refresh.ts                     refreshRun
app/shopify/gateway.ts                   ShopifyGateway interface, VariantState, SaleMarker
app/shopify/graphql-gateway.ts           GraphQL implementation, adminGraphql, withThrottleRetry
app/jobs/handlers.ts                     tick / startRun / stopRun / refreshRun handlers
app/worker.ts                            pg-boss process entry point
scripts/dev-sale.ts                      create a test sale from the command line
docs/superpowers/spikes/2026-10-08-sale-engine-dev-store.md   Task 11 results
```

---

### Task 1: Postgres and the integration-test harness

**Files:**
- Create: `docker-compose.yml`, `docker/init-test-db.sql`, `example.env`, `vitest.integration.config.ts`, `test/integration-setup.ts`, `test/db.ts`, `test/db.int.test.ts`
- Modify: `prisma/schema.prisma` (datasource), `vitest.config.ts` (exclude), `package.json` (scripts)
- Delete: `prisma/migrations/` (SQLite migration history)

**Interfaces:**
- Produces: `testDb: PrismaClient`, `resetDb(): Promise<void>` in `test/db.ts`; `npm run test:int`.

- [ ] **Step 1: Add Docker Postgres**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: salecodes
      POSTGRES_PASSWORD: salecodes
      POSTGRES_DB: salecodes
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql:ro
volumes:
  pgdata: {}
```

Create `docker/init-test-db.sql`:

```sql
CREATE DATABASE salecodes_test;
```

Create `example.env`:

```
# Copy to .env (git-ignored).
DATABASE_URL=postgresql://salecodes:salecodes@localhost:5433/salecodes
TEST_DATABASE_URL=postgresql://salecodes:salecodes@localhost:5433/salecodes_test
# Filled from `npm run env -- show` once the app is linked (Task 11):
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SCOPES=write_products
SHOPIFY_APP_URL=
```

Run:

```bash
cp example.env .env
docker compose up -d
```

Expected: `docker compose ps` shows `postgres` running.

- [ ] **Step 2: Switch Prisma to Postgres with a fresh migration history**

In `prisma/schema.prisma`, replace the `datasource db` block with:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then:

```bash
rm -rf prisma/migrations
npx prisma migrate dev --name init
```

Expected: `prisma/migrations/<timestamp>_init/migration.sql` creates the `Session` table; "Your database is now in sync with your schema".

- [ ] **Step 3: Separate unit and integration test configs**

Replace `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    exclude: ["app/**/*.int.test.ts", "test/**", "node_modules/**"],
    environment: "node",
  },
});
```

Create `vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://salecodes:salecodes@localhost:5433/salecodes_test";

export default defineConfig({
  test: {
    include: ["app/**/*.int.test.ts", "test/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./test/integration-setup.ts"],
    fileParallelism: false,
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
```

Create `test/integration-setup.ts`:

```ts
import { execSync } from "node:child_process";

export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://salecodes:salecodes@localhost:5433/salecodes_test";
  execSync("npx prisma migrate reset --force --skip-seed --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
```

In `package.json` `"scripts"`, add:

```json
"test:int": "vitest run -c vitest.integration.config.ts",
"worker": "tsx app/worker.ts"
```

- [ ] **Step 4: Write the failing harness test**

Create `test/db.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./db";

describe("integration database", () => {
  beforeEach(resetDb);

  it("connects to the test database and round-trips a session", async () => {
    await testDb.session.create({
      data: { id: "s1", shop: "demo.myshopify.com", state: "x", accessToken: "t" },
    });
    expect(await testDb.session.count()).toBe(1);
    const [{ db }] = await testDb.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(db).toBe("salecodes_test");
  });

  it("starts each test empty", async () => {
    expect(await testDb.session.count()).toBe(0);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:int`
Expected: FAIL — cannot resolve `./db`.

- [ ] **Step 6: Implement the helper**

Create `test/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

export const testDb = new PrismaClient();

const TABLES = ["Session"];

export async function resetDb(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await testDb.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 7: Run unit and integration suites**

Run: `npm run test:int`
Expected: PASS (2 tests).

Run: `npm test`
Expected: PASS (Plan 1's 66 tests, integration tests not included).

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml docker example.env prisma vitest.config.ts vitest.integration.config.ts test package.json
git commit -m "chore: switch to Postgres and add integration test harness"
```

---

### Task 2: Sale data model and money conversion

**Files:**
- Modify: `prisma/schema.prisma`, `test/db.ts` (TABLES)
- Create: migration via Prisma, `app/sales/money-db.ts`, `app/sales/money-db.test.ts`, `test/factories.ts`, `test/schema.int.test.ts`

**Interfaces:**
- Consumes: `Target` (Plan 1 `app/domain/sales/resolver.ts`), `Money`.
- Produces:
  - Prisma models `Sale`, `RuleGroup`, `SaleRun`, `PriceSnapshot`, `RunProduct`, `PriceChangeLog`; enums `SaleStatus`, `RunStatus`, `SnapshotStatus`
  - `moneyFromDb(v: bigint): Money`, `moneyToDb(v: Money): bigint`, `optionalMoneyFromDb(v: bigint | null): Money | null`, `optionalMoneyToDb(v: Money | null): bigint | null`
  - `createSale(db, input: SaleFixture): Promise<SaleWithGroups>`, `createRun(db, saleId, windowStart?, windowEnd?): Promise<SaleRun>` in `test/factories.ts`

- [ ] **Step 1: Write the failing money-db unit test**

Create `app/sales/money-db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { moneyFromDb, moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

describe("money-db", () => {
  it("converts between BigInt columns and Money", () => {
    expect(moneyFromDb(14_900_000n)).toBe(14_900_000);
    expect(moneyToDb(14_900_000)).toBe(14_900_000n);
    expect(optionalMoneyFromDb(null)).toBeNull();
    expect(optionalMoneyToDb(null)).toBeNull();
    expect(optionalMoneyToDb(5)).toBe(5n);
  });

  it("refuses values that are not safe integers", () => {
    expect(() => moneyFromDb(2n ** 60n)).toThrow();
    expect(() => moneyToDb(1.5)).toThrow();
    expect(() => moneyToDb(Number.NaN)).toThrow();
  });
});
```

Run: `npm test -- app/sales/money-db.test.ts`
Expected: FAIL — cannot resolve `./money-db`.

- [ ] **Step 2: Implement money-db**

Create `app/sales/money-db.ts`:

```ts
import type { Money } from "../domain/pricing/money";

export function moneyFromDb(value: bigint): Money {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Money value out of range: ${value}`);
  return n;
}

export function moneyToDb(value: Money): bigint {
  if (!Number.isSafeInteger(value)) throw new Error(`Money must be a safe integer, got ${value}`);
  return BigInt(value);
}

export function optionalMoneyFromDb(value: bigint | null): Money | null {
  return value === null ? null : moneyFromDb(value);
}

export function optionalMoneyToDb(value: Money | null): bigint | null {
  return value === null ? null : moneyToDb(value);
}
```

Run: `npm test -- app/sales/money-db.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the sale models**

Append to `prisma/schema.prisma`:

```prisma
enum SaleStatus {
  DRAFT
  SCHEDULED
  ACTIVE
  ENDED
  FAILED
}

enum RunStatus {
  PREPARING
  APPLYING
  ACTIVE
  RESTORING
  ENDED
  FAILED
}

enum SnapshotStatus {
  PENDING
  APPLIED
  RESTORED
  CONFLICT
  KEPT
}

model Sale {
  id           String      @id @default(cuid())
  shop         String
  title        String
  status       SaleStatus  @default(DRAFT)
  timezone     String
  priceBase    String
  rounding     Json
  minPrice     BigInt?
  tagsToAdd    String[]
  tagsToRemove String[]
  scheduleKind String
  startsAt     DateTime?
  endsAt       DateTime?
  recurring    Json?
  autoRefresh  Boolean     @default(false)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  ruleGroups   RuleGroup[]
  runs         SaleRun[]

  @@index([shop, status])
}

model RuleGroup {
  id         String @id @default(cuid())
  saleId     String
  sale       Sale   @relation(fields: [saleId], references: [id], onDelete: Cascade)
  position   Int
  priority   Int
  amountType String
  amount     Float
  targets    Json
  exclusions Json

  @@index([saleId])
}

model SaleRun {
  id              String          @id @default(cuid())
  saleId          String
  sale            Sale            @relation(fields: [saleId], references: [id], onDelete: Cascade)
  status          RunStatus       @default(PREPARING)
  windowStart     DateTime
  windowEnd       DateTime?
  startedAt       DateTime?
  endedAt         DateTime?
  lastRefreshedAt DateTime?
  error           String?
  snapshots       PriceSnapshot[]
  products        RunProduct[]

  @@unique([saleId, windowStart])
}

model PriceSnapshot {
  id                String         @id @default(cuid())
  runId             String
  run               SaleRun        @relation(fields: [runId], references: [id], onDelete: Cascade)
  variantId         String
  productId         String
  ruleGroupId       String
  originalPrice     BigInt
  originalCompareAt BigInt?
  appliedPrice      BigInt
  appliedCompareAt  BigInt
  status            SnapshotStatus @default(PENDING)
  updatedAt         DateTime       @updatedAt

  @@unique([runId, variantId])
  @@index([runId, status])
}

model RunProduct {
  id           String   @id @default(cuid())
  runId        String
  run          SaleRun  @relation(fields: [runId], references: [id], onDelete: Cascade)
  productId    String
  addedTags    String[]
  removedTags  String[]
  tagsApplied  Boolean  @default(false)
  tagsRestored Boolean  @default(false)

  @@unique([runId, productId])
}

/// Append-only: application code only ever inserts rows.
model PriceChangeLog {
  id           String   @id @default(cuid())
  shop         String
  runId        String
  variantId    String
  action       String
  oldPrice     BigInt
  oldCompareAt BigInt?
  newPrice     BigInt
  newCompareAt BigInt?
  createdAt    DateTime @default(now())

  @@index([shop, createdAt])
}
```

Run:

```bash
npx prisma migrate dev --name sale_models
```

Expected: a new migration is created and applied; Prisma Client regenerated.

- [ ] **Step 4: Update the reset helper and add factories**

In `test/db.ts`, replace `TABLES`:

```ts
const TABLES = [
  "Session",
  "PriceChangeLog",
  "RunProduct",
  "PriceSnapshot",
  "SaleRun",
  "RuleGroup",
  "Sale",
];
```

Create `test/factories.ts`:

```ts
import type { Prisma, PrismaClient, SaleStatus } from "@prisma/client";
import type { Target } from "../app/domain/sales/resolver";

export const SHOP = "demo.myshopify.com";

export interface GroupFixture {
  targets: Target[];
  exclusions?: Target[];
  amountType?: "percentOff" | "fixedOff" | "fixedPrice";
  amount?: number;
  priority?: number;
}

export interface SaleFixture {
  shop?: string;
  status?: SaleStatus;
  groups: GroupFixture[];
  priceBase?: "compareAt" | "current";
  minPrice?: bigint | null;
  tagsToAdd?: string[];
  tagsToRemove?: string[];
  autoRefresh?: boolean;
  scheduleKind?: "manual" | "once" | "recurring";
  startsAt?: Date | null;
  endsAt?: Date | null;
  recurring?: Prisma.InputJsonValue;
  timezone?: string;
}

export async function createSale(db: PrismaClient, input: SaleFixture) {
  return db.sale.create({
    data: {
      shop: input.shop ?? SHOP,
      title: "Test sale",
      status: input.status ?? "SCHEDULED",
      timezone: input.timezone ?? "Asia/Jakarta",
      priceBase: input.priceBase ?? "compareAt",
      rounding: { kind: "none" },
      minPrice: input.minPrice ?? null,
      tagsToAdd: input.tagsToAdd ?? [],
      tagsToRemove: input.tagsToRemove ?? [],
      scheduleKind: input.scheduleKind ?? "manual",
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      recurring: input.recurring,
      autoRefresh: input.autoRefresh ?? false,
      ruleGroups: {
        create: input.groups.map((g, position) => ({
          position,
          priority: g.priority ?? 1,
          amountType: g.amountType ?? "percentOff",
          amount: g.amount ?? 30,
          targets: g.targets as unknown as Prisma.InputJsonValue,
          exclusions: (g.exclusions ?? []) as unknown as Prisma.InputJsonValue,
        })),
      },
    },
    include: { ruleGroups: true },
  });
}

export async function createRun(
  db: PrismaClient,
  saleId: string,
  windowStart = new Date("2026-11-01T00:00:00Z"),
  windowEnd: Date | null = null,
) {
  return db.saleRun.create({ data: { saleId, windowStart, windowEnd } });
}
```

- [ ] **Step 5: Write the schema constraint tests**

Create `test/schema.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./db";
import { createRun, createSale } from "./factories";

const snapshot = (runId: string, variantId: string) => ({
  runId,
  variantId,
  productId: "p1",
  ruleGroupId: "g1",
  originalPrice: 20_000_000n,
  originalCompareAt: null,
  appliedPrice: 14_000_000n,
  appliedCompareAt: 20_000_000n,
});

describe("sale schema", () => {
  beforeEach(resetDb);

  it("stores a sale with rule groups and BigInt money", async () => {
    const sale = await createSale(testDb, {
      groups: [{ targets: [{ kind: "collection", id: "c1" }] }],
      minPrice: 5_000_000n,
    });
    expect(sale.ruleGroups).toHaveLength(1);
    expect(sale.minPrice).toBe(5_000_000n);
  });

  it("allows only one run per sale window", async () => {
    const sale = await createSale(testDb, { groups: [] });
    await createRun(testDb, sale.id);
    await expect(createRun(testDb, sale.id)).rejects.toThrow();
  });

  it("allows only one snapshot per variant per run", async () => {
    const sale = await createSale(testDb, { groups: [] });
    const run = await createRun(testDb, sale.id);
    await testDb.priceSnapshot.create({ data: snapshot(run.id, "v1") });
    await expect(testDb.priceSnapshot.create({ data: snapshot(run.id, "v1") })).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:int`
Expected: PASS (5 tests). If the new schema test was run before Step 3's migration, it fails on missing tables — that is the RED for this step.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma app/sales/money-db.ts app/sales/money-db.test.ts test
git commit -m "feat: add sale persistence models and money conversion"
```

---

### Task 3: Sale plan (pure)

**Files:**
- Create: `app/domain/sales/plan.ts`, `app/domain/sales/plan.test.ts`

**Interfaces:**
- Consumes: `calculateSalePrice`, `PricingOptions`, `VariantPrice`, `SkipReason` (Plan 1 calculator); `RuleGroupInput`, `ResolvedVariant` (Plan 1 resolver).
- Produces:
  - `type PlanSkipReason = SkipReason | "not_found" | "in_other_sale"`
  - `interface PlannedChange { variantId: string; productId: string; ruleGroupId: string; originalPrice: Money; originalCompareAt: Money | null; newPrice: Money; newCompareAt: Money }`
  - `interface SkippedVariant { variantId: string; productId: string; ruleGroupId: string; reason: PlanSkipReason }`
  - `interface SalePlan { changes: PlannedChange[]; skipped: SkippedVariant[] }`
  - `computeSalePlan(groups: readonly RuleGroupInput[], resolved: readonly ResolvedVariant[], prices: ReadonlyMap<string, VariantPrice>, options: PricingOptions): SalePlan`

- [ ] **Step 1: Write the failing test**

Create `app/domain/sales/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PricingOptions } from "../pricing/calculator";
import { computeSalePlan } from "./plan";
import type { RuleGroupInput } from "./resolver";

const RP = (rupiah: number) => rupiah * 100;
const options: PricingOptions = { priceBase: "compareAt", rounding: { kind: "none" }, minPrice: null };

const groups: RuleGroupInput[] = [
  { id: "g30", priority: 1, discount: { type: "percentOff", amount: 30 }, targets: [], exclusions: [] },
  { id: "gFixed", priority: 1, discount: { type: "fixedPrice", amount: RP(99_000) }, targets: [], exclusions: [] },
];

describe("computeSalePlan", () => {
  it("prices each variant with its own group's discount", () => {
    const plan = computeSalePlan(
      groups,
      [
        { variantId: "v1", productId: "p1", ruleGroupId: "g30" },
        { variantId: "v2", productId: "p2", ruleGroupId: "gFixed" },
      ],
      new Map([
        ["v1", { price: RP(200_000), compareAt: null }],
        ["v2", { price: RP(150_000), compareAt: RP(180_000) }],
      ]),
      options,
    );
    expect(plan.changes).toEqual([
      {
        variantId: "v1", productId: "p1", ruleGroupId: "g30",
        originalPrice: RP(200_000), originalCompareAt: null,
        newPrice: RP(140_000), newCompareAt: RP(200_000),
      },
      {
        variantId: "v2", productId: "p2", ruleGroupId: "gFixed",
        originalPrice: RP(150_000), originalCompareAt: RP(180_000),
        newPrice: RP(99_000), newCompareAt: RP(180_000),
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("reports skipped variants with the calculator's reason", () => {
    const plan = computeSalePlan(
      groups,
      [{ variantId: "v1", productId: "p1", ruleGroupId: "gFixed" }],
      new Map([["v1", { price: RP(90_000), compareAt: null }]]),
      options,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ variantId: "v1", productId: "p1", ruleGroupId: "gFixed", reason: "not_lower" }]);
  });

  it("reports variants with no price data as not_found", () => {
    const plan = computeSalePlan(groups, [{ variantId: "gone", productId: "p1", ruleGroupId: "g30" }], new Map(), options);
    expect(plan.skipped).toEqual([{ variantId: "gone", productId: "p1", ruleGroupId: "g30", reason: "not_found" }]);
  });
});
```

Run: `npm test -- app/domain/sales/plan.test.ts`
Expected: FAIL — cannot resolve `./plan`.

- [ ] **Step 2: Implement**

Create `app/domain/sales/plan.ts`:

```ts
import {
  calculateSalePrice,
  type PricingOptions,
  type SkipReason,
  type VariantPrice,
} from "../pricing/calculator";
import type { Money } from "../pricing/money";
import type { ResolvedVariant, RuleGroupInput } from "./resolver";

export type PlanSkipReason = SkipReason | "not_found" | "in_other_sale";

export interface PlannedChange {
  variantId: string;
  productId: string;
  ruleGroupId: string;
  originalPrice: Money;
  originalCompareAt: Money | null;
  newPrice: Money;
  newCompareAt: Money;
}

export interface SkippedVariant {
  variantId: string;
  productId: string;
  ruleGroupId: string;
  reason: PlanSkipReason;
}

export interface SalePlan {
  changes: PlannedChange[];
  skipped: SkippedVariant[];
}

export function computeSalePlan(
  groups: readonly RuleGroupInput[],
  resolved: readonly ResolvedVariant[],
  prices: ReadonlyMap<string, VariantPrice>,
  options: PricingOptions,
): SalePlan {
  const discounts = new Map(groups.map((g) => [g.id, g.discount]));
  const plan: SalePlan = { changes: [], skipped: [] };

  for (const variant of resolved) {
    const price = prices.get(variant.variantId);
    const discount = discounts.get(variant.ruleGroupId);
    if (!price || !discount) {
      plan.skipped.push({ ...variant, reason: "not_found" });
      continue;
    }
    const result = calculateSalePrice(price, discount, options);
    if (result.ok) {
      plan.changes.push({
        ...variant,
        originalPrice: price.price,
        originalCompareAt: price.compareAt,
        newPrice: result.newPrice,
        newCompareAt: result.newCompareAt,
      });
    } else {
      plan.skipped.push({ ...variant, reason: result.reason });
    }
  }
  return plan;
}
```

Run: `npm test -- app/domain/sales/plan.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add app/domain/sales/plan.ts app/domain/sales/plan.test.ts
git commit -m "feat: add pure sale plan computation"
```

---

### Task 4: Shopify gateway — interface, GraphQL implementation, fake

**Files:**
- Create: `app/shopify/gateway.ts`, `app/shopify/graphql-gateway.ts`, `app/shopify/graphql-gateway.test.ts`, `test/fake-shopify.ts`

**Interfaces:**
- Consumes: `Money`, `parseMoney`, `formatMoney` (Plan 1); `Target`, `CatalogIndex` (Plan 1 resolver).
- Produces (`app/shopify/gateway.ts`):
  - `interface SaleMarker { saleId: string; runId: string; originalPrice: Money; originalCompareAt: Money | null }`
  - `interface VariantState { variantId: string; productId: string; price: Money; compareAt: Money | null; marker: SaleMarker | null }`
  - `interface PriceWrite { variantId: string; price: Money; compareAt: Money | null; marker?: SaleMarker }` — `marker` set → metafield written; omitted → metafield untouched
  - `interface ShopifyGateway { loadCatalog(targets: readonly Target[]): Promise<CatalogIndex>; getVariants(variantIds: readonly string[]): Promise<Map<string, VariantState>>; writePrices(productId: string, writes: readonly PriceWrite[]): Promise<void>; clearMarkers(variantIds: readonly string[]): Promise<void>; getProductTags(productIds: readonly string[]): Promise<Map<string, string[]>>; addTags(productId: string, tags: readonly string[]): Promise<void>; removeTags(productId: string, tags: readonly string[]): Promise<void> }`
  - `serializeMarker(m: SaleMarker): string`, `parseMarker(value: string | null | undefined): SaleMarker | null`
- Produces (`app/shopify/graphql-gateway.ts`): `type GraphqlFn = (query: string, variables?: Record<string, unknown>) => Promise<any>`, `createGraphqlGateway(graphql: GraphqlFn): ShopifyGateway`, `adminGraphql(admin: AdminLike, sleep?): GraphqlFn`, `withThrottleRetry<T>(fn, sleep, retries?): Promise<T>`, `class ShopifyGraphqlError`.
- Produces (`test/fake-shopify.ts`): `class FakeShopify implements ShopifyGateway` with `addVariant`, `setCollection`, `setTags`, `variants`, `tags`, `writeCount`, `failAfterWrites`.

- [ ] **Step 1: Write the gateway types**

Create `app/shopify/gateway.ts`:

```ts
import type { CatalogIndex, Target } from "../domain/sales/resolver";
import { formatMoney, parseMoney, type Money } from "../domain/pricing/money";

export const MARKER_NAMESPACE = "$app";
export const MARKER_KEY = "sale_state";

/** Stored on each variant while it is on sale: marker for the Function + copy of originals. */
export interface SaleMarker {
  saleId: string;
  runId: string;
  originalPrice: Money;
  originalCompareAt: Money | null;
}

export interface VariantState {
  variantId: string;
  productId: string;
  price: Money;
  compareAt: Money | null;
  marker: SaleMarker | null;
}

export interface PriceWrite {
  variantId: string;
  price: Money;
  compareAt: Money | null;
  /** Set to write the sale marker metafield; omit to leave it untouched. */
  marker?: SaleMarker;
}

export interface ShopifyGateway {
  loadCatalog(targets: readonly Target[]): Promise<CatalogIndex>;
  getVariants(variantIds: readonly string[]): Promise<Map<string, VariantState>>;
  writePrices(productId: string, writes: readonly PriceWrite[]): Promise<void>;
  clearMarkers(variantIds: readonly string[]): Promise<void>;
  getProductTags(productIds: readonly string[]): Promise<Map<string, string[]>>;
  addTags(productId: string, tags: readonly string[]): Promise<void>;
  removeTags(productId: string, tags: readonly string[]): Promise<void>;
}

export function serializeMarker(marker: SaleMarker): string {
  return JSON.stringify({
    saleId: marker.saleId,
    runId: marker.runId,
    originalPrice: formatMoney(marker.originalPrice),
    originalCompareAt: marker.originalCompareAt === null ? null : formatMoney(marker.originalCompareAt),
  });
}

export function parseMarker(value: string | null | undefined): SaleMarker | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value);
    if (typeof raw.saleId !== "string" || typeof raw.runId !== "string") return null;
    return {
      saleId: raw.saleId,
      runId: raw.runId,
      originalPrice: parseMoney(raw.originalPrice),
      originalCompareAt: raw.originalCompareAt === null ? null : parseMoney(raw.originalCompareAt),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Write the failing GraphQL gateway tests**

Create `app/shopify/graphql-gateway.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { serializeMarker } from "./gateway";
import {
  createGraphqlGateway,
  ShopifyGraphqlError,
  withThrottleRetry,
  type GraphqlFn,
} from "./graphql-gateway";

type Handler = (vars: any) => any;

function scripted(handlers: Record<string, Handler>) {
  const calls: { name: string; vars: any }[] = [];
  const fn: GraphqlFn = async (query, vars) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)![1];
    calls.push({ name, vars });
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected operation ${name}`);
    return handler(vars);
  };
  return { fn, calls };
}

const page = (ids: string[], endCursor: string | null) => ({
  nodes: ids.map((id) => ({ id })),
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

describe("createGraphqlGateway", () => {
  it("loads collection products across pages, then each product's variants", async () => {
    const { fn } = scripted({
      CollectionProducts: (v) => ({
        collection: { products: v.after ? page(["p2"], null) : page(["p1"], "c1") },
      }),
      VariantProducts: () => ({ nodes: [{ id: "v9", product: { id: "p3" } }] }),
      ProductVariants: (v) => ({ product: { variants: page([`${v.id}-a`, `${v.id}-b`], null) } }),
    });
    const catalog = await createGraphqlGateway(fn).loadCatalog([
      { kind: "collection", id: "col" },
      { kind: "variant", id: "v9" },
    ]);
    expect(catalog.collectionProducts.get("col")).toEqual(["p1", "p2"]);
    expect([...catalog.productVariants.keys()].sort()).toEqual(["p1", "p2", "p3"]);
    expect(catalog.productVariants.get("p1")).toEqual(["p1-a", "p1-b"]);
  });

  it("maps variant prices and the sale marker", async () => {
    const marker = { saleId: "s1", runId: "r1", originalPrice: 20_000_000, originalCompareAt: null };
    const { fn } = scripted({
      VariantStates: () => ({
        nodes: [
          {
            id: "v1",
            price: "140000.00",
            compareAtPrice: "200000.00",
            product: { id: "p1" },
            metafield: { value: serializeMarker(marker) },
          },
          { id: "v2", price: "50000.00", compareAtPrice: null, product: { id: "p1" }, metafield: null },
          null,
        ],
      }),
    });
    const states = await createGraphqlGateway(fn).getVariants(["v1", "v2", "deleted"]);
    expect(states.get("v1")).toEqual({
      variantId: "v1", productId: "p1", price: 14_000_000, compareAt: 20_000_000, marker,
    });
    expect(states.get("v2")?.marker).toBeNull();
    expect(states.has("deleted")).toBe(false);
  });

  it("writes formatted prices and the marker metafield only when given", async () => {
    const { fn, calls } = scripted({
      VariantsBulkUpdate: () => ({ productVariantsBulkUpdate: { userErrors: [] } }),
    });
    await createGraphqlGateway(fn).writePrices("p1", [
      { variantId: "v1", price: 14_000_000, compareAt: 20_000_000,
        marker: { saleId: "s", runId: "r", originalPrice: 20_000_000, originalCompareAt: null } },
      { variantId: "v2", price: 5_000_000, compareAt: null },
    ]);
    const variants = calls[0].vars.variants;
    expect(calls[0].vars.productId).toBe("p1");
    expect(variants[0]).toMatchObject({ id: "v1", price: "140000.00", compareAtPrice: "200000.00" });
    expect(variants[0].metafields[0]).toMatchObject({ namespace: "$app", key: "sale_state", type: "json" });
    expect(variants[1]).toEqual({ id: "v2", price: "50000.00", compareAtPrice: null });
  });

  it("throws on user errors", async () => {
    const { fn } = scripted({
      VariantsBulkUpdate: () => ({
        productVariantsBulkUpdate: { userErrors: [{ field: ["price"], message: "bad", code: "INVALID" }] },
      }),
    });
    await expect(
      createGraphqlGateway(fn).writePrices("p1", [{ variantId: "v1", price: 1, compareAt: null }]),
    ).rejects.toThrow(/bad/);
  });

  it("clears markers with metafield identifiers", async () => {
    const { fn, calls } = scripted({ ClearSaleMarkers: () => ({ metafieldsDelete: { userErrors: [] } }) });
    await createGraphqlGateway(fn).clearMarkers(["v1"]);
    expect(calls[0].vars.metafields).toEqual([{ ownerId: "v1", namespace: "$app", key: "sale_state" }]);
  });
});

describe("withThrottleRetry", () => {
  it("retries throttled errors with backoff, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const result = await withThrottleRetry(async () => {
      if (++attempts < 3) throw new ShopifyGraphqlError("Throttled", true);
      return "ok";
    }, sleep);
    expect(result).toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("rethrows non-throttled errors immediately", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      withThrottleRetry(async () => { throw new ShopifyGraphqlError("Access denied", false); }, sleep),
    ).rejects.toThrow("Access denied");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the retry limit", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      withThrottleRetry(async () => { throw new ShopifyGraphqlError("Throttled", true); }, sleep, 2),
    ).rejects.toThrow("Throttled");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
```

Run: `npm test -- app/shopify`
Expected: FAIL — cannot resolve `./graphql-gateway`.

- [ ] **Step 3: Implement the GraphQL gateway**

Create `app/shopify/graphql-gateway.ts`:

```ts
import { formatMoney, parseMoney } from "../domain/pricing/money";
import type { CatalogIndex, Target } from "../domain/sales/resolver";
import {
  MARKER_KEY,
  MARKER_NAMESPACE,
  parseMarker,
  serializeMarker,
  type ShopifyGateway,
  type VariantState,
} from "./gateway";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GraphqlFn = (query: string, variables?: Record<string, unknown>) => Promise<any>;

const PAGE_SIZE = 250;

const COLLECTION_PRODUCTS = `#graphql
query CollectionProducts($id: ID!, $after: String) {
  collection(id: $id) { products(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`;

const PRODUCT_VARIANTS = `#graphql
query ProductVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`;

const VARIANT_PRODUCTS = `#graphql
query VariantProducts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { id product { id } } }
}`;

const VARIANT_STATES = `#graphql
query VariantStates($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      price
      compareAtPrice
      product { id }
      metafield(namespace: "${MARKER_NAMESPACE}", key: "${MARKER_KEY}") { value }
    }
  }
}`;

const VARIANTS_BULK_UPDATE = `#graphql
mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message code } }
}`;

const CLEAR_SALE_MARKERS = `#graphql
mutation ClearSaleMarkers($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { userErrors { field message } }
}`;

const PRODUCT_TAGS = `#graphql
query ProductTags($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Product { id tags } }
}`;

const ADD_TAGS = `#graphql
mutation AddTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;

const REMOVE_TAGS = `#graphql
mutation RemoveTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`;

export function createGraphqlGateway(graphql: GraphqlFn): ShopifyGateway {
  return {
    async loadCatalog(targets: readonly Target[]): Promise<CatalogIndex> {
      const collectionProducts = new Map<string, string[]>();
      const productIds = new Set<string>();
      const variantTargets: string[] = [];

      for (const target of targets) {
        if (target.kind === "collection" && !collectionProducts.has(target.id)) {
          const ids = await paginate(graphql, COLLECTION_PRODUCTS, { id: target.id }, (d) => d.collection?.products);
          collectionProducts.set(target.id, ids);
          ids.forEach((id) => productIds.add(id));
        } else if (target.kind === "product") {
          productIds.add(target.id);
        } else if (target.kind === "variant") {
          variantTargets.push(target.id);
        }
      }
      for (const ids of chunks(variantTargets, PAGE_SIZE)) {
        const data = await graphql(VARIANT_PRODUCTS, { ids });
        for (const node of data.nodes) if (node?.product) productIds.add(node.product.id);
      }

      const productVariants = new Map<string, string[]>();
      for (const id of productIds) {
        productVariants.set(id, await paginate(graphql, PRODUCT_VARIANTS, { id }, (d) => d.product?.variants));
      }
      return { collectionProducts, productVariants };
    },

    async getVariants(variantIds) {
      const states = new Map<string, VariantState>();
      for (const ids of chunks(variantIds, PAGE_SIZE)) {
        const data = await graphql(VARIANT_STATES, { ids });
        for (const node of data.nodes) {
          if (!node?.id || !node.product) continue;
          states.set(node.id, {
            variantId: node.id,
            productId: node.product.id,
            price: parseMoney(node.price),
            compareAt: node.compareAtPrice === null ? null : parseMoney(node.compareAtPrice),
            marker: parseMarker(node.metafield?.value),
          });
        }
      }
      return states;
    },

    async writePrices(productId, writes) {
      if (writes.length === 0) return;
      const variants = writes.map((w) => ({
        id: w.variantId,
        price: formatMoney(w.price),
        compareAtPrice: w.compareAt === null ? null : formatMoney(w.compareAt),
        ...(w.marker
          ? {
              metafields: [
                { namespace: MARKER_NAMESPACE, key: MARKER_KEY, type: "json", value: serializeMarker(w.marker) },
              ],
            }
          : {}),
      }));
      const data = await graphql(VARIANTS_BULK_UPDATE, { productId, variants });
      assertNoUserErrors(data.productVariantsBulkUpdate.userErrors);
    },

    async clearMarkers(variantIds) {
      for (const ids of chunks(variantIds, PAGE_SIZE)) {
        const metafields = ids.map((ownerId) => ({ ownerId, namespace: MARKER_NAMESPACE, key: MARKER_KEY }));
        const data = await graphql(CLEAR_SALE_MARKERS, { metafields });
        assertNoUserErrors(data.metafieldsDelete.userErrors);
      }
    },

    async getProductTags(productIds) {
      const tags = new Map<string, string[]>();
      for (const ids of chunks(productIds, PAGE_SIZE)) {
        const data = await graphql(PRODUCT_TAGS, { ids });
        for (const node of data.nodes) if (node?.id) tags.set(node.id, node.tags ?? []);
      }
      return tags;
    },

    async addTags(productId, tags) {
      if (tags.length === 0) return;
      const data = await graphql(ADD_TAGS, { id: productId, tags });
      assertNoUserErrors(data.tagsAdd.userErrors);
    },

    async removeTags(productId, tags) {
      if (tags.length === 0) return;
      const data = await graphql(REMOVE_TAGS, { id: productId, tags });
      assertNoUserErrors(data.tagsRemove.userErrors);
    },
  };
}

interface Connection {
  nodes: { id: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function paginate(
  graphql: GraphqlFn,
  query: string,
  variables: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pick: (data: any) => Connection | null | undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const connection = pick(await graphql(query, { ...variables, after }));
    if (!connection) return ids;
    ids.push(...connection.nodes.map((n) => n.id));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function assertNoUserErrors(errors: { message: string }[] | undefined): void {
  if (errors && errors.length > 0) {
    throw new ShopifyGraphqlError(errors.map((e) => e.message).join("; "), false);
  }
}

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly throttled: boolean,
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

export interface AdminLike {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wraps the template's admin client: unwraps `data`, raises typed errors, retries throttling. */
export function adminGraphql(admin: AdminLike, sleep = defaultSleep): GraphqlFn {
  return (query, variables) =>
    withThrottleRetry(async () => {
      let body;
      try {
        const response = await admin.graphql(query, { variables });
        body = await response.json();
      } catch (error) {
        throw toGraphqlError(error);
      }
      if (body.errors?.length) throw toGraphqlError(body.errors);
      return body.data;
    }, sleep);
}

function toGraphqlError(error: unknown): ShopifyGraphqlError {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return new ShopifyGraphqlError(message, /throttled/i.test(message));
}

export async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  retries = 5,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const throttled = error instanceof ShopifyGraphqlError && error.throttled;
      if (!throttled || attempt >= retries) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
```

Run: `npm test -- app/shopify`
Expected: PASS (8 tests).

- [ ] **Step 4: Add the in-memory fake for integration tests**

Create `test/fake-shopify.ts`:

```ts
import type { Money } from "../app/domain/pricing/money";
import type { CatalogIndex, Target } from "../app/domain/sales/resolver";
import type { PriceWrite, ShopifyGateway, VariantState } from "../app/shopify/gateway";

/** In-memory Shopify. `failAfterWrites` simulates a crash after N successful price writes. */
export class FakeShopify implements ShopifyGateway {
  variants = new Map<string, VariantState>();
  collections = new Map<string, string[]>();
  tags = new Map<string, string[]>();
  writeCount = 0;
  failAfterWrites: number | null = null;

  addVariant(variantId: string, productId: string, price: Money, compareAt: Money | null = null) {
    this.variants.set(variantId, { variantId, productId, price, compareAt, marker: null });
  }

  setCollection(collectionId: string, productIds: string[]) {
    this.collections.set(collectionId, productIds);
  }

  setTags(productId: string, tags: string[]) {
    this.tags.set(productId, [...tags]);
  }

  async loadCatalog(targets: readonly Target[]): Promise<CatalogIndex> {
    const collectionProducts = new Map<string, string[]>();
    for (const t of targets) {
      if (t.kind === "collection") collectionProducts.set(t.id, [...(this.collections.get(t.id) ?? [])]);
    }
    const productVariants = new Map<string, string[]>();
    for (const v of this.variants.values()) {
      productVariants.set(v.productId, [...(productVariants.get(v.productId) ?? []), v.variantId]);
    }
    return { collectionProducts, productVariants };
  }

  async getVariants(variantIds: readonly string[]) {
    const result = new Map<string, VariantState>();
    for (const id of variantIds) {
      const v = this.variants.get(id);
      if (v) result.set(id, { ...v, marker: v.marker ? { ...v.marker } : null });
    }
    return result;
  }

  async writePrices(productId: string, writes: readonly PriceWrite[]) {
    if (this.failAfterWrites !== null && this.writeCount >= this.failAfterWrites) {
      throw new Error("simulated crash");
    }
    for (const w of writes) {
      const v = this.variants.get(w.variantId);
      if (!v || v.productId !== productId) throw new Error(`Unknown variant ${w.variantId}`);
      v.price = w.price;
      v.compareAt = w.compareAt;
      if (w.marker) v.marker = { ...w.marker };
    }
    this.writeCount++;
  }

  async clearMarkers(variantIds: readonly string[]) {
    for (const id of variantIds) {
      const v = this.variants.get(id);
      if (v) v.marker = null;
    }
  }

  async getProductTags(productIds: readonly string[]) {
    return new Map(productIds.map((id) => [id, [...(this.tags.get(id) ?? [])]]));
  }

  async addTags(productId: string, tags: readonly string[]) {
    const current = this.tags.get(productId) ?? [];
    this.tags.set(productId, [...current, ...tags.filter((t) => !current.includes(t))]);
  }

  async removeTags(productId: string, tags: readonly string[]) {
    this.tags.set(productId, (this.tags.get(productId) ?? []).filter((t) => !tags.includes(t)));
  }
}
```

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/shopify test/fake-shopify.ts
git commit -m "feat: add Shopify gateway with GraphQL implementation and test fake"
```

---

### Task 5: Prepare a run (snapshots, overlap check, count check)

**Files:**
- Create: `app/sales/load.ts`, `app/sales/prepare.ts`, `app/sales/prepare.int.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `resolveSale`, `findOverlaps` (Plan 1).
- Produces (`app/sales/load.ts`):
  - `type SaleWithGroups = Prisma.SaleGetPayload<{ include: { ruleGroups: true } }>`
  - `toRuleGroupInputs(sale: SaleWithGroups): RuleGroupInput[]`
  - `toPricingOptions(sale: Sale): PricingOptions`
  - `planForSale(gateway: ShopifyGateway, sale: SaleWithGroups, runId: string | null): Promise<SalePlan>` — variants carrying another run's marker are skipped as `in_other_sale`; variants carrying **this** run's marker are priced from the marker's originals
  - `toSnapshotRow(runId: string, change: PlannedChange): Prisma.PriceSnapshotCreateManyInput`
- Produces (`app/sales/prepare.ts`):
  - `type PrepareResult = { status: "ready"; count: number; skipped: SkippedVariant[] } | { status: "already_prepared" } | { status: "overlap"; overlaps: Overlap[] }`
  - `prepareRun(db: PrismaClient, gateway: ShopifyGateway, runId: string): Promise<PrepareResult>` — only acts on runs in `PREPARING`; on success the run moves to `APPLYING`

- [ ] **Step 1: Write the failing tests**

Create `app/sales/prepare.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { prepareRun } from "./prepare";

const RP = (rupiah: number) => rupiah * 100;

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(400_000), RP(500_000));
  shopify.addVariant("v3", "p2", RP(90_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

describe("prepareRun", () => {
  beforeEach(resetDb);

  it("saves one snapshot per changed variant and moves the run to APPLYING", async () => {
    const shopify = store();
    const sale = await createSale(testDb, {
      groups: [{ targets: [{ kind: "collection", id: "summer" }], amountType: "fixedPrice", amount: RP(100_000) }],
    });
    const run = await createRun(testDb, sale.id);

    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toMatchObject({ status: "ready", count: 2 });
    if (result.status === "ready") {
      expect(result.skipped).toEqual([{ variantId: "v3", productId: "p2", ruleGroupId: expect.any(String), reason: "not_lower" }]);
    }
    const snaps = await testDb.priceSnapshot.findMany({ where: { runId: run.id }, orderBy: { variantId: "asc" } });
    expect(snaps.map((s) => [s.variantId, s.originalPrice, s.originalCompareAt, s.appliedPrice, s.appliedCompareAt, s.status])).toEqual([
      ["v1", 20_000_000n, null, 10_000_000n, 20_000_000n, "PENDING"],
      ["v2", 40_000_000n, 50_000_000n, 10_000_000n, 50_000_000n, "PENDING"],
    ]);
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("APPLYING");
    expect(shopify.writeCount).toBe(0);
  });

  it("does nothing for a run that is already prepared", async () => {
    const shopify = store();
    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const run = await createRun(testDb, sale.id);
    await prepareRun(testDb, shopify, run.id);

    expect(await prepareRun(testDb, shopify, run.id)).toEqual({ status: "already_prepared" });
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id } })).toBe(2);
  });

  it("fails the run when variants are already in another active sale", async () => {
    const shopify = store();
    const other = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const otherRun = await createRun(testDb, other.id);
    await prepareRun(testDb, shopify, otherRun.id);

    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "collection", id: "summer" }] }] });
    const run = await createRun(testDb, sale.id);
    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toEqual({ status: "overlap", overlaps: [{ saleId: other.id, variantIds: ["v1", "v2"] }] });
    const failed = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain(other.id);
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  it("skips variants still marked by another run", async () => {
    const shopify = store();
    shopify.variants.get("v1")!.marker = { saleId: "old", runId: "old-run", originalPrice: 1, originalCompareAt: null };
    const sale = await createSale(testDb, { groups: [{ targets: [{ kind: "product", id: "p1" }] }] });
    const run = await createRun(testDb, sale.id);

    const result = await prepareRun(testDb, shopify, run.id);

    expect(result).toMatchObject({ status: "ready", count: 1 });
    if (result.status === "ready") expect(result.skipped.map((s) => [s.variantId, s.reason])).toEqual([["v1", "in_other_sale"]]);
  });
});
```

Run: `npm run test:int -- app/sales/prepare.int.test.ts`
Expected: FAIL — cannot resolve `./prepare`.

- [ ] **Step 2: Implement the loader**

Create `app/sales/load.ts`:

```ts
import type { Prisma, Sale } from "@prisma/client";
import type { AmountType, PriceBase, PricingOptions, VariantPrice } from "../domain/pricing/calculator";
import type { RoundingRule } from "../domain/pricing/rounding";
import { computeSalePlan, type PlannedChange, type SalePlan } from "../domain/sales/plan";
import { resolveSale, type RuleGroupInput, type Target } from "../domain/sales/resolver";
import type { ShopifyGateway } from "../shopify/gateway";
import { moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

export type SaleWithGroups = Prisma.SaleGetPayload<{ include: { ruleGroups: true } }>;

export function toRuleGroupInputs(sale: SaleWithGroups): RuleGroupInput[] {
  return [...sale.ruleGroups]
    .sort((a, b) => a.position - b.position)
    .map((g) => ({
      id: g.id,
      priority: g.priority,
      discount: { type: g.amountType as AmountType, amount: g.amount },
      targets: g.targets as unknown as Target[],
      exclusions: g.exclusions as unknown as Target[],
    }));
}

export function toPricingOptions(sale: Sale): PricingOptions {
  return {
    priceBase: sale.priceBase as PriceBase,
    rounding: sale.rounding as unknown as RoundingRule,
    minPrice: optionalMoneyFromDb(sale.minPrice),
  };
}

/**
 * Resolves the sale against the live catalog and prices each variant.
 * Variants marked by another run are skipped; variants marked by `runId`
 * are priced from their recorded originals (they are already discounted).
 */
export async function planForSale(
  gateway: ShopifyGateway,
  sale: SaleWithGroups,
  runId: string | null,
): Promise<SalePlan> {
  const groups = toRuleGroupInputs(sale);
  const catalog = await gateway.loadCatalog(groups.flatMap((g) => [...g.targets, ...g.exclusions]));
  const resolved = resolveSale(groups, catalog);
  const states = await gateway.getVariants(resolved.map((r) => r.variantId));

  const prices = new Map<string, VariantPrice>();
  const inOtherSale = new Set<string>();
  for (const r of resolved) {
    const state = states.get(r.variantId);
    if (!state) continue;
    if (state.marker && state.marker.runId !== runId) {
      inOtherSale.add(r.variantId);
    } else if (state.marker) {
      prices.set(r.variantId, { price: state.marker.originalPrice, compareAt: state.marker.originalCompareAt });
    } else {
      prices.set(r.variantId, { price: state.price, compareAt: state.compareAt });
    }
  }

  const plan = computeSalePlan(
    groups,
    resolved.filter((r) => !inOtherSale.has(r.variantId)),
    prices,
    toPricingOptions(sale),
  );
  for (const r of resolved) {
    if (inOtherSale.has(r.variantId)) plan.skipped.push({ ...r, reason: "in_other_sale" });
  }
  return plan;
}

export function toSnapshotRow(runId: string, change: PlannedChange): Prisma.PriceSnapshotCreateManyInput {
  return {
    runId,
    variantId: change.variantId,
    productId: change.productId,
    ruleGroupId: change.ruleGroupId,
    originalPrice: moneyToDb(change.originalPrice),
    originalCompareAt: optionalMoneyToDb(change.originalCompareAt),
    appliedPrice: moneyToDb(change.newPrice),
    appliedCompareAt: moneyToDb(change.newCompareAt),
  };
}
```

- [ ] **Step 3: Implement prepareRun**

Create `app/sales/prepare.ts`:

```ts
import type { PrismaClient, Sale } from "@prisma/client";
import type { SkippedVariant } from "../domain/sales/plan";
import { findOverlaps, type Overlap, type SaleVariants } from "../domain/sales/overlap";
import type { ShopifyGateway } from "../shopify/gateway";
import { planForSale, toSnapshotRow } from "./load";

export type PrepareResult =
  | { status: "ready"; count: number; skipped: SkippedVariant[] }
  | { status: "already_prepared" }
  | { status: "overlap"; overlaps: Overlap[] };

export async function prepareRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<PrepareResult> {
  const run = await db.saleRun.findUniqueOrThrow({
    where: { id: runId },
    include: { sale: { include: { ruleGroups: true } } },
  });
  if (run.status !== "PREPARING") return { status: "already_prepared" };

  const plan = await planForSale(gateway, run.sale, runId);

  const overlaps = await findActiveOverlaps(db, run.sale, plan.changes.map((c) => c.variantId));
  if (overlaps.length > 0) {
    await db.saleRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error: `Products overlap with active sales: ${overlaps.map((o) => o.saleId).join(", ")}`,
      },
    });
    return { status: "overlap", overlaps };
  }

  // All snapshots or none, verified, before Shopify is touched (spec §5.4 steps 2–3).
  await db.$transaction(async (tx) => {
    await tx.priceSnapshot.createMany({ data: plan.changes.map((c) => toSnapshotRow(runId, c)) });
    const saved = await tx.priceSnapshot.count({ where: { runId } });
    if (saved !== plan.changes.length) {
      throw new Error(`Snapshot count mismatch: expected ${plan.changes.length}, saved ${saved}`);
    }
    await tx.saleRun.update({ where: { id: runId }, data: { status: "APPLYING" } });
  });

  return { status: "ready", count: plan.changes.length, skipped: plan.skipped };
}

async function findActiveOverlaps(db: PrismaClient, sale: Sale, variantIds: string[]): Promise<Overlap[]> {
  const rows = await db.priceSnapshot.findMany({
    where: {
      status: { in: ["PENDING", "APPLIED"] },
      run: { status: { in: ["APPLYING", "ACTIVE", "RESTORING"] }, sale: { shop: sale.shop, id: { not: sale.id } } },
    },
    select: { variantId: true, run: { select: { saleId: true } } },
  });
  const bySale = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = bySale.get(row.run.saleId) ?? new Set<string>();
    set.add(row.variantId);
    bySale.set(row.run.saleId, set);
  }
  const others: SaleVariants[] = [...bySale].map(([saleId, ids]) => ({ saleId, variantIds: ids }));
  return findOverlaps(variantIds, others);
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:int -- app/sales/prepare.int.test.ts`
Expected: PASS (4 tests).

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/sales/load.ts app/sales/prepare.ts app/sales/prepare.int.test.ts
git commit -m "feat: prepare sale runs with transactional snapshots and overlap check"
```

---

### Task 6: Apply a run (prices, markers, tags, crash recovery)

**Files:**
- Create: `app/sales/apply.ts`, `app/sales/apply.int.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  - `applyRun(db: PrismaClient, gateway: ShopifyGateway, runId: string): Promise<{ applied: number; conflicts: number }>` — processes `PENDING` snapshots for runs in `APPLYING` or `ACTIVE`; moves `APPLYING` → `ACTIVE`; throws for other statuses
  - `snapshotMatches(state: VariantState, price: bigint, compareAt: bigint | null): boolean` (exported for Task 7)
  - `groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]>` (exported for Task 7)

- [ ] **Step 1: Write the failing tests**

Create `app/sales/apply.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { prepareRun } from "./prepare";

const RP = (rupiah: number) => rupiah * 100;

async function preparedRun(shopify: FakeShopify, extra: { tagsToAdd?: string[]; tagsToRemove?: string[] } = {}) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    ...extra,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  return { sale, run };
}

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(100_000));
  shopify.addVariant("v3", "p2", RP(300_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

describe("applyRun", () => {
  beforeEach(resetDb);

  it("writes sale prices with markers, logs them, and activates the run", async () => {
    const shopify = store();
    const { sale, run } = await preparedRun(shopify);

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 3, conflicts: 0 });

    expect(shopify.variants.get("v1")).toMatchObject({
      price: RP(140_000),
      compareAt: RP(200_000),
      marker: { saleId: sale.id, runId: run.id, originalPrice: RP(200_000), originalCompareAt: null },
    });
    expect(await testDb.priceSnapshot.count({ where: { runId: run.id, status: "APPLIED" } })).toBe(3);
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, action: "apply" } })).toBe(3);
    const active = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(active.status).toBe("ACTIVE");
    expect(active.startedAt).not.toBeNull();
  });

  it("recovers from a crash without writing or logging twice", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.failAfterWrites = 1; // p1 is written, then the "worker" dies before p2

    await expect(applyRun(testDb, shopify, run.id)).rejects.toThrow("simulated crash");
    shopify.failAfterWrites = null;
    const writesBeforeRetry = shopify.writeCount;

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 1, conflicts: 0 });
    expect(shopify.writeCount).toBe(writesBeforeRetry + 1); // only p2 written on retry
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id } })).toBe(3);
    expect(shopify.variants.get("v3")!.price).toBe(RP(210_000));
  });

  it("reconciles a write that succeeded right before the DB update failed", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    // Simulate: Shopify already has the sale price + marker, DB still says PENDING.
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } });
    await shopify.writePrices("p2", [{
      variantId: "v3", price: RP(210_000), compareAt: RP(300_000),
      marker: { saleId: "s", runId: run.id, originalPrice: RP(300_000), originalCompareAt: null },
    }]);
    const writes = shopify.writeCount;

    await applyRun(testDb, shopify, run.id);

    expect(shopify.writeCount).toBe(writes + 1); // p1 only; p2 reconciled, not rewritten
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: snap.id } })).status).toBe("APPLIED");
  });

  it("marks a conflict and keeps the merchant's price if it changed after the snapshot", async () => {
    const shopify = store();
    const { run } = await preparedRun(shopify);
    shopify.variants.get("v1")!.price = RP(180_000); // merchant edit between prepare and apply

    expect(await applyRun(testDb, shopify, run.id)).toEqual({ applied: 2, conflicts: 1 });
    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(180_000), marker: null });
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    expect(snap.status).toBe("CONFLICT");
  });

  it("adds only missing tags and removes requested ones, recording both", async () => {
    const shopify = store();
    shopify.setTags("p1", ["sale", "new-in"]);
    shopify.setTags("p2", ["basics"]);
    const { run } = await preparedRun(shopify, { tagsToAdd: ["sale"], tagsToRemove: ["new-in"] });

    await applyRun(testDb, shopify, run.id);

    expect(shopify.tags.get("p1")).toEqual(["sale"]);
    expect(shopify.tags.get("p2")).toEqual(["basics", "sale"]);
    const rows = await testDb.runProduct.findMany({ where: { runId: run.id }, orderBy: { productId: "asc" } });
    expect(rows.map((r) => [r.productId, r.addedTags, r.removedTags, r.tagsApplied])).toEqual([
      ["p1", [], ["new-in"], true],
      ["p2", ["sale"], [], true],
    ]);
  });

  it("refuses runs that are not prepared", async () => {
    const shopify = store();
    const sale = await createSale(testDb, { groups: [] });
    const run = await createRun(testDb, sale.id);
    await expect(applyRun(testDb, shopify, run.id)).rejects.toThrow(/PREPARING/);
  });
});
```

Run: `npm run test:int -- app/sales/apply.int.test.ts`
Expected: FAIL — cannot resolve `./apply`.

- [ ] **Step 2: Implement applyRun**

Create `app/sales/apply.ts`:

```ts
import type { PriceSnapshot, PrismaClient, Sale, SaleRun } from "@prisma/client";
import type { ShopifyGateway, VariantState } from "../shopify/gateway";
import { moneyFromDb, optionalMoneyFromDb } from "./money-db";

export async function applyRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<{ applied: number; conflicts: number }> {
  const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
  if (run.status !== "APPLYING" && run.status !== "ACTIVE") {
    throw new Error(`Run ${runId} cannot be applied in status ${run.status}`);
  }

  const pending = await db.priceSnapshot.findMany({
    where: { runId, status: "PENDING" },
    orderBy: { variantId: "asc" },
  });
  const states = await gateway.getVariants(pending.map((s) => s.variantId));

  let applied = 0;
  let conflicts = 0;
  for (const [productId, snaps] of groupBy(pending, (s) => s.productId)) {
    const alreadyWritten: PriceSnapshot[] = [];
    const toWrite: PriceSnapshot[] = [];
    const conflicted: PriceSnapshot[] = [];

    for (const snap of snaps) {
      const state = states.get(snap.variantId);
      if (state && state.marker?.runId === runId && snapshotMatches(state, snap.appliedPrice, snap.appliedCompareAt)) {
        alreadyWritten.push(snap); // a previous attempt wrote it but crashed before the DB update
      } else if (state && snapshotMatches(state, snap.originalPrice, snap.originalCompareAt)) {
        toWrite.push(snap);
      } else {
        conflicted.push(snap); // changed by someone else since the snapshot, or deleted
      }
    }

    if (toWrite.length > 0) {
      await gateway.writePrices(
        productId,
        toWrite.map((s) => ({
          variantId: s.variantId,
          price: moneyFromDb(s.appliedPrice),
          compareAt: moneyFromDb(s.appliedCompareAt),
          marker: {
            saleId: run.saleId,
            runId,
            originalPrice: moneyFromDb(s.originalPrice),
            originalCompareAt: optionalMoneyFromDb(s.originalCompareAt),
          },
        })),
      );
    }

    const nowApplied = [...alreadyWritten, ...toWrite];
    await db.$transaction([
      db.priceSnapshot.updateMany({ where: { id: { in: nowApplied.map((s) => s.id) } }, data: { status: "APPLIED" } }),
      db.priceSnapshot.updateMany({ where: { id: { in: conflicted.map((s) => s.id) } }, data: { status: "CONFLICT" } }),
      db.priceChangeLog.createMany({
        data: nowApplied.map((s) => ({
          shop: run.sale.shop,
          runId,
          variantId: s.variantId,
          action: "apply",
          oldPrice: s.originalPrice,
          oldCompareAt: s.originalCompareAt,
          newPrice: s.appliedPrice,
          newCompareAt: s.appliedCompareAt,
        })),
      }),
    ]);
    applied += nowApplied.length;
    conflicts += conflicted.length;
  }

  await applyTags(db, gateway, run);

  if (run.status === "APPLYING") {
    await db.saleRun.update({ where: { id: runId }, data: { status: "ACTIVE", startedAt: new Date() } });
  }
  return { applied, conflicts };
}

/** Records the tag change first, then applies it, so a crash can always be undone. */
async function applyTags(db: PrismaClient, gateway: ShopifyGateway, run: SaleRun & { sale: Sale }) {
  const { tagsToAdd, tagsToRemove } = run.sale;
  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) return;

  const appliedProducts = await db.priceSnapshot.findMany({
    where: { runId: run.id, status: "APPLIED" },
    distinct: ["productId"],
    select: { productId: true },
  });
  const recorded = await db.runProduct.findMany({ where: { runId: run.id } });
  const recordedIds = new Set(recorded.map((r) => r.productId));
  const newIds = appliedProducts.map((p) => p.productId).filter((id) => !recordedIds.has(id));

  const currentTags = await gateway.getProductTags(newIds);
  for (const productId of newIds) {
    const tags = new Set(currentTags.get(productId) ?? []);
    await db.runProduct.create({
      data: {
        runId: run.id,
        productId,
        addedTags: tagsToAdd.filter((t) => !tags.has(t)),
        removedTags: tagsToRemove.filter((t) => tags.has(t)),
      },
    });
  }

  const unapplied = await db.runProduct.findMany({ where: { runId: run.id, tagsApplied: false } });
  for (const row of unapplied) {
    await gateway.addTags(row.productId, row.addedTags);
    await gateway.removeTags(row.productId, row.removedTags);
    await db.runProduct.update({ where: { id: row.id }, data: { tagsApplied: true } });
  }
}

export function snapshotMatches(state: VariantState, price: bigint, compareAt: bigint | null): boolean {
  return state.price === moneyFromDb(price) && state.compareAt === optionalMoneyFromDb(compareAt);
}

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
```

- [ ] **Step 3: Run tests**

Run: `npm run test:int -- app/sales/apply.int.test.ts`
Expected: PASS (6 tests).

Run: `npm run test:int && npm test && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add app/sales/apply.ts app/sales/apply.int.test.ts
git commit -m "feat: apply sale runs with markers, tags and crash reconciliation"
```

---

### Task 7: Restore, conflict resolution, metafield recovery

**Files:**
- Create: `app/sales/restore.ts`, `app/sales/restore.int.test.ts`

**Interfaces:**
- Consumes: `snapshotMatches`, `groupBy` (Task 6); gateway (Task 4).
- Produces:
  - `restoreRun(db, gateway, runId): Promise<{ restored: number; conflicts: number }>` — handles `PENDING` and `APPLIED` snapshots; restores tags; run → `ENDED`. No-op for `ENDED` runs.
  - `restoreSnapshots(db, gateway, shop: string, runId: string, snapshots: PriceSnapshot[]): Promise<{ restored: number; conflicts: number }>` (used by Task 8)
  - `resolveConflict(db, gateway, snapshotId: string, choice: "restore" | "keep"): Promise<void>`
  - `recoverFromMetafields(gateway, variantIds: string[]): Promise<number>` — restores any variant still carrying a marker, using the marker's originals

Rules per snapshot (spec §5.5):
- variant gone → `RESTORED` (nothing left to restore)
- Shopify shows the **original** prices → already restored (or never applied) → clear marker if present, `RESTORED`
- Shopify shows the **applied** prices → write originals, clear marker, `RESTORED`, log
- anything else → `CONFLICT`, untouched

- [ ] **Step 1: Write the failing tests**

Create `app/sales/restore.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { prepareRun } from "./prepare";
import { recoverFromMetafields, resolveConflict, restoreRun } from "./restore";

const RP = (rupiah: number) => rupiah * 100;

function store() {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.addVariant("v2", "p1", RP(400_000), RP(500_000));
  shopify.addVariant("v3", "p2", RP(300_000));
  shopify.setCollection("summer", ["p1", "p2"]);
  return shopify;
}

async function activeRun(shopify: FakeShopify, tags: { tagsToAdd?: string[]; tagsToRemove?: string[] } = {}) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    ...tags,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  await applyRun(testDb, shopify, run.id);
  return run;
}

describe("restoreRun", () => {
  beforeEach(resetDb);

  it("restores original prices, clears markers, logs, and ends the run", async () => {
    const shopify = store();
    const run = await activeRun(shopify);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });

    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(400_000), compareAt: RP(500_000), marker: null });
    expect(await testDb.priceChangeLog.count({ where: { runId: run.id, action: "restore" } })).toBe(3);
    const ended = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(ended.status).toBe("ENDED");
    expect(ended.endedAt).not.toBeNull();
  });

  it("never overwrites a price edited by hand during the sale", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 2, conflicts: 1 });
    expect(shopify.variants.get("v1")!.price).toBe(RP(99_000));
    const snap = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    expect(snap.status).toBe("CONFLICT");
  });

  it("finishes a restore that crashed after writing prices but before clearing markers", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    // Simulate the crash: original prices written back, markers still present, DB still APPLIED.
    await shopify.writePrices("p2", [{ variantId: "v3", price: RP(300_000), compareAt: null }]);

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });
    expect(shopify.variants.get("v3")!.marker).toBeNull();
  });

  it("treats a variant deleted during the sale as restored", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.delete("v3");

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 3, conflicts: 0 });
  });

  it("removes only the tags it added and puts back the tags it removed", async () => {
    const shopify = store();
    shopify.setTags("p1", ["sale", "new-in"]);
    shopify.setTags("p2", []);
    const run = await activeRun(shopify, { tagsToAdd: ["sale"], tagsToRemove: ["new-in"] });

    await restoreRun(testDb, shopify, run.id);

    expect(shopify.tags.get("p1")!.sort()).toEqual(["new-in", "sale"]); // "sale" was there before
    expect(shopify.tags.get("p2")).toEqual([]);
  });

  it("is a no-op for an ended run", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    await restoreRun(testDb, shopify, run.id);
    const writes = shopify.writeCount;

    expect(await restoreRun(testDb, shopify, run.id)).toEqual({ restored: 0, conflicts: 0 });
    expect(shopify.writeCount).toBe(writes);
  });
});

describe("resolveConflict", () => {
  beforeEach(resetDb);

  it("restores anyway, or keeps the current price", async () => {
    const shopify = store();
    const run = await activeRun(shopify);
    shopify.variants.get("v1")!.price = RP(99_000);
    shopify.variants.get("v3")!.price = RP(250_000);
    await restoreRun(testDb, shopify, run.id);
    const v1 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v1" } });
    const v3 = await testDb.priceSnapshot.findFirstOrThrow({ where: { runId: run.id, variantId: "v3" } });

    await resolveConflict(testDb, shopify, v1.id, "restore");
    await resolveConflict(testDb, shopify, v3.id, "keep");

    expect(shopify.variants.get("v1")).toMatchObject({ price: RP(200_000), compareAt: null, marker: null });
    expect(shopify.variants.get("v3")).toMatchObject({ price: RP(250_000), marker: null });
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("RESTORED");
    expect((await testDb.priceSnapshot.findUniqueOrThrow({ where: { id: v3.id } })).status).toBe("KEPT");
  });
});

describe("recoverFromMetafields", () => {
  it("restores originals from markers when DB snapshots are unavailable", async () => {
    const shopify = store();
    await shopify.writePrices("p1", [{
      variantId: "v2", price: RP(280_000), compareAt: RP(500_000),
      marker: { saleId: "s", runId: "r", originalPrice: RP(400_000), originalCompareAt: RP(500_000) },
    }]);

    expect(await recoverFromMetafields(shopify, ["v1", "v2"])).toBe(1);
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(400_000), compareAt: RP(500_000), marker: null });
  });
});
```

Run: `npm run test:int -- app/sales/restore.int.test.ts`
Expected: FAIL — cannot resolve `./restore`.

- [ ] **Step 2: Implement**

Create `app/sales/restore.ts`:

```ts
import type { PriceSnapshot, PrismaClient } from "@prisma/client";
import type { ShopifyGateway } from "../shopify/gateway";
import { groupBy, snapshotMatches } from "./apply";
import { moneyFromDb, moneyToDb, optionalMoneyFromDb, optionalMoneyToDb } from "./money-db";

export async function restoreRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<{ restored: number; conflicts: number }> {
  const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
  if (run.status === "ENDED") return { restored: 0, conflicts: 0 };

  await db.saleRun.update({ where: { id: runId }, data: { status: "RESTORING" } });
  const snapshots = await db.priceSnapshot.findMany({
    where: { runId, status: { in: ["PENDING", "APPLIED"] } },
    orderBy: { variantId: "asc" },
  });
  const result = await restoreSnapshots(db, gateway, run.sale.shop, runId, snapshots);
  await restoreTags(db, gateway, runId);
  await db.saleRun.update({ where: { id: runId }, data: { status: "ENDED", endedAt: new Date() } });
  return result;
}

export async function restoreSnapshots(
  db: PrismaClient,
  gateway: ShopifyGateway,
  shop: string,
  runId: string,
  snapshots: PriceSnapshot[],
): Promise<{ restored: number; conflicts: number }> {
  const states = await gateway.getVariants(snapshots.map((s) => s.variantId));
  let restored = 0;
  let conflicts = 0;

  for (const [productId, snaps] of groupBy(snapshots, (s) => s.productId)) {
    const settled: PriceSnapshot[] = []; // gone, or already back at original prices
    const toWrite: PriceSnapshot[] = [];
    const conflicted: PriceSnapshot[] = [];
    const markersToClear: string[] = [];

    for (const snap of snaps) {
      const state = states.get(snap.variantId);
      if (!state) {
        settled.push(snap);
      } else if (snapshotMatches(state, snap.originalPrice, snap.originalCompareAt)) {
        settled.push(snap);
        if (state.marker) markersToClear.push(snap.variantId);
      } else if (snapshotMatches(state, snap.appliedPrice, snap.appliedCompareAt)) {
        toWrite.push(snap);
        markersToClear.push(snap.variantId);
      } else {
        conflicted.push(snap);
      }
    }

    if (toWrite.length > 0) {
      await gateway.writePrices(
        productId,
        toWrite.map((s) => ({
          variantId: s.variantId,
          price: moneyFromDb(s.originalPrice),
          compareAt: optionalMoneyFromDb(s.originalCompareAt),
        })),
      );
    }
    if (markersToClear.length > 0) await gateway.clearMarkers(markersToClear);

    // Settled APPLIED snapshots were restored by a crashed attempt: log them now.
    const logged = [...toWrite, ...settled.filter((s) => s.status === "APPLIED" && states.has(s.variantId))];
    await db.$transaction([
      db.priceSnapshot.updateMany({
        where: { id: { in: [...settled, ...toWrite].map((s) => s.id) } },
        data: { status: "RESTORED" },
      }),
      db.priceSnapshot.updateMany({ where: { id: { in: conflicted.map((s) => s.id) } }, data: { status: "CONFLICT" } }),
      db.priceChangeLog.createMany({
        data: logged.map((s) => ({
          shop,
          runId,
          variantId: s.variantId,
          action: "restore",
          oldPrice: s.appliedPrice,
          oldCompareAt: s.appliedCompareAt,
          newPrice: s.originalPrice,
          newCompareAt: s.originalCompareAt,
        })),
      }),
    ]);
    restored += settled.length + toWrite.length;
    conflicts += conflicted.length;
  }
  return { restored, conflicts };
}

async function restoreTags(db: PrismaClient, gateway: ShopifyGateway, runId: string) {
  const rows = await db.runProduct.findMany({ where: { runId, tagsRestored: false } });
  for (const row of rows) {
    await gateway.removeTags(row.productId, row.addedTags);
    await gateway.addTags(row.productId, row.removedTags);
    await db.runProduct.update({ where: { id: row.id }, data: { tagsRestored: true } });
  }
}

export async function resolveConflict(
  db: PrismaClient,
  gateway: ShopifyGateway,
  snapshotId: string,
  choice: "restore" | "keep",
): Promise<void> {
  const snap = await db.priceSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, include: { run: { include: { sale: true } } } });
  if (snap.status !== "CONFLICT") throw new Error(`Snapshot ${snapshotId} is not in conflict`);

  if (choice === "restore") {
    const current = (await gateway.getVariants([snap.variantId])).get(snap.variantId);
    await gateway.writePrices(snap.productId, [
      { variantId: snap.variantId, price: moneyFromDb(snap.originalPrice), compareAt: optionalMoneyFromDb(snap.originalCompareAt) },
    ]);
    if (current) {
      await db.priceChangeLog.create({
        data: {
          shop: snap.run.sale.shop,
          runId: snap.runId,
          variantId: snap.variantId,
          action: "restore",
          oldPrice: moneyToDb(current.price),
          oldCompareAt: optionalMoneyToDb(current.compareAt),
          newPrice: snap.originalPrice,
          newCompareAt: snap.originalCompareAt,
        },
      });
    }
  }
  await gateway.clearMarkers([snap.variantId]);
  await db.priceSnapshot.update({
    where: { id: snapshotId },
    data: { status: choice === "restore" ? "RESTORED" : "KEPT" },
  });
}

/** Last-resort recovery using the original prices stored on each variant (spec §5.5). */
export async function recoverFromMetafields(gateway: ShopifyGateway, variantIds: string[]): Promise<number> {
  const states = [...(await gateway.getVariants(variantIds)).values()].filter((s) => s.marker);
  for (const [productId, group] of groupBy(states, (s) => s.productId)) {
    await gateway.writePrices(
      productId,
      group.map((s) => ({ variantId: s.variantId, price: s.marker!.originalPrice, compareAt: s.marker!.originalCompareAt })),
    );
  }
  await gateway.clearMarkers(states.map((s) => s.variantId));
  return states.length;
}
```

- [ ] **Step 3: Run tests**

Run: `npm run test:int -- app/sales/restore.int.test.ts`
Expected: PASS (8 tests).

Run: `npm run test:int && npm test && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add app/sales/restore.ts app/sales/restore.int.test.ts
git commit -m "feat: restore sale runs safely with conflict handling and metafield recovery"
```

---

### Task 8: Auto-refresh

**Files:**
- Create: `app/sales/refresh.ts`, `app/sales/refresh.int.test.ts`

**Interfaces:**
- Consumes: `planForSale`, `toSnapshotRow` (Task 5); `applyRun` (Task 6); `restoreSnapshots` (Task 7).
- Produces: `refreshRun(db, gateway, runId): Promise<{ added: number; removed: number }>` — only for `ACTIVE` runs of sales with `autoRefresh`; adds variants that newly match, restores variants that no longer match; sets `lastRefreshedAt`.

Known limit (ledger it, not a bug): a variant that left and later re-enters the collection during the same run is not re-added, because `(runId, variantId)` is unique. Tags on products that leave stay until the run ends.

- [ ] **Step 1: Write the failing tests**

Create `app/sales/refresh.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createRun, createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { applyRun } from "./apply";
import { prepareRun } from "./prepare";
import { refreshRun } from "./refresh";

const RP = (rupiah: number) => rupiah * 100;

async function activeRun(shopify: FakeShopify, autoRefresh = true) {
  const sale = await createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    autoRefresh,
  });
  const run = await createRun(testDb, sale.id);
  await prepareRun(testDb, shopify, run.id);
  await applyRun(testDb, shopify, run.id);
  return run;
}

describe("refreshRun", () => {
  beforeEach(resetDb);

  it("applies the sale to products added to the collection and restores products that left", async () => {
    const shopify = new FakeShopify();
    shopify.addVariant("v1", "p1", RP(200_000));
    shopify.addVariant("v2", "p2", RP(100_000));
    shopify.addVariant("v3", "p3", RP(300_000));
    shopify.setCollection("summer", ["p1", "p2"]);
    const run = await activeRun(shopify);

    shopify.setCollection("summer", ["p1", "p3"]); // p2 removed, p3 added

    expect(await refreshRun(testDb, shopify, run.id)).toEqual({ added: 1, removed: 1 });
    expect(shopify.variants.get("v1")!.price).toBe(RP(140_000)); // untouched
    expect(shopify.variants.get("v2")).toMatchObject({ price: RP(100_000), marker: null });
    expect(shopify.variants.get("v3")!.price).toBe(RP(210_000));
    const refreshed = await testDb.saleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshed.status).toBe("ACTIVE");
    expect(refreshed.lastRefreshedAt).not.toBeNull();
  });

  it("does nothing when auto-refresh is off", async () => {
    const shopify = new FakeShopify();
    shopify.addVariant("v1", "p1", RP(200_000));
    shopify.addVariant("v3", "p3", RP(300_000));
    shopify.setCollection("summer", ["p1"]);
    const run = await activeRun(shopify, false);
    shopify.setCollection("summer", ["p1", "p3"]);

    expect(await refreshRun(testDb, shopify, run.id)).toEqual({ added: 0, removed: 0 });
    expect(shopify.variants.get("v3")!.price).toBe(RP(300_000));
  });
});
```

Run: `npm run test:int -- app/sales/refresh.int.test.ts`
Expected: FAIL — cannot resolve `./refresh`.

- [ ] **Step 2: Implement**

Create `app/sales/refresh.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { ShopifyGateway } from "../shopify/gateway";
import { applyRun } from "./apply";
import { planForSale, toSnapshotRow } from "./load";
import { restoreSnapshots } from "./restore";

export async function refreshRun(
  db: PrismaClient,
  gateway: ShopifyGateway,
  runId: string,
): Promise<{ added: number; removed: number }> {
  const run = await db.saleRun.findUniqueOrThrow({
    where: { id: runId },
    include: { sale: { include: { ruleGroups: true } } },
  });
  if (run.status !== "ACTIVE" || !run.sale.autoRefresh) return { added: 0, removed: 0 };

  const plan = await planForSale(gateway, run.sale, runId);
  const snapshots = await db.priceSnapshot.findMany({ where: { runId } });
  const known = new Set(snapshots.map((s) => s.variantId));
  const planned = new Set(plan.changes.map((c) => c.variantId));

  const added = plan.changes.filter((c) => !known.has(c.variantId));
  if (added.length > 0) {
    await db.priceSnapshot.createMany({ data: added.map((c) => toSnapshotRow(runId, c)), skipDuplicates: true });
  }

  const leaving = snapshots.filter((s) => s.status === "APPLIED" && !planned.has(s.variantId));
  if (leaving.length > 0) await restoreSnapshots(db, gateway, run.sale.shop, runId, leaving);
  if (added.length > 0) await applyRun(db, gateway, runId);

  await db.saleRun.update({ where: { id: runId }, data: { lastRefreshedAt: new Date() } });
  return { added: added.length, removed: leaving.length };
}
```

- [ ] **Step 3: Run tests**

Run: `npm run test:int -- app/sales/refresh.int.test.ts`
Expected: PASS (2 tests).

Run: `npm run test:int && npm test && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add app/sales/refresh.ts app/sales/refresh.int.test.ts
git commit -m "feat: auto-refresh active sales as collection membership changes"
```

---

### Task 9: Due actions (pure scheduling decisions)

**Files:**
- Create: `app/domain/schedule/due.ts`, `app/domain/schedule/due.test.ts`

**Interfaces:**
- Consumes: `expandRecurring`, `RecurringSchedule` (Plan 1).
- Produces:
  - `type ScheduleKind = "manual" | "once" | "recurring"`
  - `interface ScheduleSale { scheduleKind: ScheduleKind; startsAt: Date | null; endsAt: Date | null; recurring: RecurringSchedule | null; timezone: string }`
  - `interface ScheduleRun { id: string; windowStart: Date; windowEnd: Date | null; open: boolean }` (`open` = run is PREPARING, APPLYING, ACTIVE or RESTORING)
  - `type DueAction = { kind: "start"; windowStart: Date; windowEnd: Date | null } | { kind: "stop"; runId: string } | { kind: "complete" }`
  - `dueActions(sale: ScheduleSale, runs: readonly ScheduleRun[], now: Date): DueAction[]`

Rules:
- Any open run whose `windowEnd <= now` → `stop`.
- **once:** `start` if `now >= startsAt`, not past `endsAt`, and no run exists for `startsAt` (a missed start is applied late only while the window is open, spec §5.6). `complete` when no run is open and either `endsAt` has passed or the window's run already exists.
- **recurring:** `start` for each window open at `now` that has no run. `complete` when no run is open and `now` is 2 days past `lastDate` (after the last possible overnight window).
- **manual:** only `stop`s from runs with an end (none in v1).

- [ ] **Step 1: Write the failing tests**

Create `app/domain/schedule/due.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dueActions, type ScheduleRun, type ScheduleSale } from "./due";

const at = (iso: string) => new Date(iso);

const once: ScheduleSale = {
  scheduleKind: "once",
  startsAt: at("2026-11-06T12:00:00Z"),
  endsAt: at("2026-11-08T12:00:00Z"),
  recurring: null,
  timezone: "Asia/Jakarta",
};

const run = (patch: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: "r1",
  windowStart: at("2026-11-06T12:00:00Z"),
  windowEnd: at("2026-11-08T12:00:00Z"),
  open: true,
  ...patch,
});

describe("dueActions — once", () => {
  it("does nothing before the start", () => {
    expect(dueActions(once, [], at("2026-11-06T11:59:00Z"))).toEqual([]);
  });

  it("starts at or after the start time while the window is open", () => {
    expect(dueActions(once, [], at("2026-11-07T00:00:00Z"))).toEqual([
      { kind: "start", windowStart: once.startsAt, windowEnd: once.endsAt },
    ]);
  });

  it("does not start twice", () => {
    expect(dueActions(once, [run()], at("2026-11-07T00:00:00Z"))).toEqual([]);
  });

  it("stops the open run at the end", () => {
    expect(dueActions(once, [run()], at("2026-11-08T12:00:00Z"))).toEqual([{ kind: "stop", runId: "r1" }]);
  });

  it("completes once the run is closed", () => {
    expect(dueActions(once, [run({ open: false })], at("2026-11-08T12:01:00Z"))).toEqual([{ kind: "complete" }]);
  });

  it("never starts a sale whose whole window was missed, and completes it", () => {
    expect(dueActions(once, [], at("2026-11-09T00:00:00Z"))).toEqual([{ kind: "complete" }]);
  });

  it("with no end date, completes only after its run is closed", () => {
    const openEnded = { ...once, endsAt: null };
    expect(dueActions(openEnded, [run({ windowEnd: null })], at("2026-12-01T00:00:00Z"))).toEqual([]);
    expect(dueActions(openEnded, [run({ windowEnd: null, open: false })], at("2026-12-01T00:00:00Z"))).toEqual([
      { kind: "complete" },
    ]);
  });
});

describe("dueActions — recurring", () => {
  const recurring: ScheduleSale = {
    scheduleKind: "recurring",
    startsAt: null,
    endsAt: null,
    timezone: "Asia/Jakarta",
    recurring: { weekdays: [5], startTime: "19:00", stopTime: "23:00", firstDate: "2026-11-06", lastDate: "2026-11-13" },
  };

  it("starts the window that is open now", () => {
    expect(dueActions(recurring, [], at("2026-11-06T13:00:00Z"))).toEqual([
      { kind: "start", windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z") },
    ]);
  });

  it("does nothing between windows", () => {
    const past = run({ windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z"), open: false });
    expect(dueActions(recurring, [past], at("2026-11-09T00:00:00Z"))).toEqual([]);
  });

  it("stops a window at its end", () => {
    const current = run({ windowStart: at("2026-11-06T12:00:00Z"), windowEnd: at("2026-11-06T16:00:00Z") });
    expect(dueActions(recurring, [current], at("2026-11-06T16:00:00Z"))).toEqual([{ kind: "stop", runId: "r1" }]);
  });

  it("completes after the last date", () => {
    expect(dueActions(recurring, [], at("2026-11-16T00:00:00Z"))).toEqual([{ kind: "complete" }]);
  });
});

describe("dueActions — manual", () => {
  it("never schedules anything", () => {
    const manual: ScheduleSale = { scheduleKind: "manual", startsAt: null, endsAt: null, recurring: null, timezone: "Asia/Jakarta" };
    expect(dueActions(manual, [run({ windowEnd: null })], at("2030-01-01T00:00:00Z"))).toEqual([]);
  });
});
```

Run: `npm test -- app/domain/schedule/due.test.ts`
Expected: FAIL — cannot resolve `./due`.

- [ ] **Step 2: Implement**

Create `app/domain/schedule/due.ts`:

```ts
import { DateTime } from "luxon";
import { expandRecurring, type RecurringSchedule } from "./recurring";

export type ScheduleKind = "manual" | "once" | "recurring";

export interface ScheduleSale {
  scheduleKind: ScheduleKind;
  startsAt: Date | null;
  endsAt: Date | null;
  recurring: RecurringSchedule | null;
  timezone: string;
}

export interface ScheduleRun {
  id: string;
  windowStart: Date;
  windowEnd: Date | null;
  /** PREPARING, APPLYING, ACTIVE or RESTORING. */
  open: boolean;
}

export type DueAction =
  | { kind: "start"; windowStart: Date; windowEnd: Date | null }
  | { kind: "stop"; runId: string }
  | { kind: "complete" };

export function dueActions(sale: ScheduleSale, runs: readonly ScheduleRun[], now: Date): DueAction[] {
  const actions: DueAction[] = [];
  for (const run of runs) {
    if (run.open && run.windowEnd && run.windowEnd <= now) actions.push({ kind: "stop", runId: run.id });
  }
  const anyOpen = runs.some((r) => r.open);
  const hasRun = (start: Date) => runs.some((r) => r.windowStart.getTime() === start.getTime());

  switch (sale.scheduleKind) {
    case "manual":
      return actions;

    case "once": {
      if (!sale.startsAt) throw new Error("A one-time sale needs startsAt");
      const pastEnd = sale.endsAt !== null && now >= sale.endsAt;
      if (!pastEnd && now >= sale.startsAt && !hasRun(sale.startsAt)) {
        actions.push({ kind: "start", windowStart: sale.startsAt, windowEnd: sale.endsAt });
      }
      if (!anyOpen && (pastEnd || hasRun(sale.startsAt))) actions.push({ kind: "complete" });
      return actions;
    }

    case "recurring": {
      if (!sale.recurring) throw new Error("A recurring sale needs a recurring schedule");
      const openWindows = expandRecurring(sale.recurring, sale.timezone, now, new Date(now.getTime() + 1));
      for (const window of openWindows) {
        if (!hasRun(window.start)) actions.push({ kind: "start", windowStart: window.start, windowEnd: window.end });
      }
      const afterLastWindow = DateTime.fromISO(sale.recurring.lastDate, { zone: sale.timezone })
        .plus({ days: 2 })
        .toJSDate();
      if (!anyOpen && now >= afterLastWindow) actions.push({ kind: "complete" });
      return actions;
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- app/domain/schedule/due.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 4: Commit**

```bash
git add app/domain/schedule/due.ts app/domain/schedule/due.test.ts
git commit -m "feat: add pure due-action scheduling for sales"
```

---

### Task 10: Job handlers and the pg-boss worker

**Files:**
- Create: `app/jobs/handlers.ts`, `app/jobs/handlers.int.test.ts`, `app/worker.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: Tasks 5–9; `unauthenticated` from `app/shopify.server.ts`; `adminGraphql`, `createGraphqlGateway` (Task 4).
- Produces:
  - `QUEUES = { tick: "sale-tick", start: "run-start", stop: "run-stop", refresh: "run-refresh" } as const`; `type RunQueue = "run-start" | "run-stop" | "run-refresh"`
  - `REFRESH_INTERVAL_MS = 20 * 60 * 1000`
  - `interface JobDeps { db: PrismaClient; gatewayFor(shop: string): Promise<ShopifyGateway>; send(queue: RunQueue, data: { runId: string }): Promise<void>; now(): Date }`
  - `createJobHandlers(deps: JobDeps): { tick(): Promise<void>; startRun(runId: string): Promise<void>; stopRun(runId: string): Promise<void>; refreshRun(runId: string): Promise<void> }`

Error rule: `startRun`/`stopRun`/`refreshRun` record the error message on `SaleRun.error` and rethrow so pg-boss retries (5 retries with backoff).

- [ ] **Step 1: Install dependencies**

```bash
npm install pg-boss@10
npm install -D tsx
```

- [ ] **Step 2: Write the failing tests**

Create `app/jobs/handlers.int.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createSale } from "../../test/factories";
import { FakeShopify } from "../../test/fake-shopify";
import { createJobHandlers, REFRESH_INTERVAL_MS, type RunQueue } from "./handlers";

const RP = (rupiah: number) => rupiah * 100;
const START = new Date("2026-11-06T12:00:00Z");
const END = new Date("2026-11-07T12:00:00Z");

function setup(nowRef: { now: Date }) {
  const shopify = new FakeShopify();
  shopify.addVariant("v1", "p1", RP(200_000));
  shopify.setCollection("summer", ["p1"]);
  const sent: { queue: RunQueue; runId: string }[] = [];
  const handlers = createJobHandlers({
    db: testDb,
    gatewayFor: async () => shopify,
    send: async (queue, data) => { sent.push({ queue, runId: data.runId }); },
    now: () => nowRef.now,
  });
  return { shopify, sent, handlers };
}

async function onceSale(autoRefresh = false) {
  return createSale(testDb, {
    groups: [{ targets: [{ kind: "collection", id: "summer" }], amount: 30 }],
    scheduleKind: "once",
    startsAt: START,
    endsAt: END,
    autoRefresh,
  });
}

describe("job handlers", () => {
  beforeEach(resetDb);

  it("runs a one-time sale end to end: start, apply, stop, restore, complete", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    const sale = await onceSale();

    await handlers.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe("run-start");
    await handlers.startRun(sent[0].runId);
    expect(shopify.variants.get("v1")!.price).toBe(RP(140_000));
    expect((await testDb.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("ACTIVE");

    clock.now = END;
    await handlers.tick();
    expect(sent[1]).toEqual({ queue: "run-stop", runId: sent[0].runId });
    await handlers.stopRun(sent[1].runId);
    expect(shopify.variants.get("v1")!.price).toBe(RP(200_000));

    await handlers.tick();
    expect((await testDb.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("ENDED");
  });

  it("creates only one run per window even if the tick runs twice", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { sent, handlers } = setup(clock);
    await onceSale();

    await Promise.all([handlers.tick(), handlers.tick()]);

    expect(await testDb.saleRun.count()).toBe(1);
    expect(sent.filter((s) => s.queue === "run-start")).toHaveLength(1);
  });

  it("queues a refresh for auto-refresh sales every 20 minutes", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { sent, handlers } = setup(clock);
    await onceSale(true);
    await handlers.tick();
    await handlers.startRun(sent[0].runId);

    clock.now = new Date(clock.now.getTime() + REFRESH_INTERVAL_MS);
    await handlers.tick();

    expect(sent.at(-1)).toEqual({ queue: "run-refresh", runId: sent[0].runId });
  });

  it("records the error on the run and rethrows so the job is retried", async () => {
    const clock = { now: new Date("2026-11-06T12:00:30Z") };
    const { shopify, sent, handlers } = setup(clock);
    await onceSale();
    await handlers.tick();
    shopify.failAfterWrites = 0;

    await expect(handlers.startRun(sent[0].runId)).rejects.toThrow("simulated crash");
    expect((await testDb.saleRun.findUniqueOrThrow({ where: { id: sent[0].runId } })).error).toBe("simulated crash");
  });
});
```

Run: `npm run test:int -- app/jobs`
Expected: FAIL — cannot resolve `./handlers`.

- [ ] **Step 3: Implement the handlers**

Create `app/jobs/handlers.ts`:

```ts
import { Prisma, type PrismaClient, type Sale, type SaleRun } from "@prisma/client";
import { dueActions, type ScheduleKind, type ScheduleSale } from "../domain/schedule/due";
import type { RecurringSchedule } from "../domain/schedule/recurring";
import { applyRun } from "../sales/apply";
import { prepareRun } from "../sales/prepare";
import { refreshRun } from "../sales/refresh";
import { restoreRun } from "../sales/restore";
import type { ShopifyGateway } from "../shopify/gateway";

export const QUEUES = {
  tick: "sale-tick",
  start: "run-start",
  stop: "run-stop",
  refresh: "run-refresh",
} as const;

export type RunQueue = (typeof QUEUES)["start" | "stop" | "refresh"];

export const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

const OPEN_STATUSES = new Set(["PREPARING", "APPLYING", "ACTIVE", "RESTORING"]);

export interface JobDeps {
  db: PrismaClient;
  gatewayFor(shop: string): Promise<ShopifyGateway>;
  send(queue: RunQueue, data: { runId: string }): Promise<void>;
  now(): Date;
}

export function createJobHandlers(deps: JobDeps) {
  const { db } = deps;

  async function withRun(runId: string, work: (run: SaleRun & { sale: Sale }, gateway: ShopifyGateway) => Promise<void>) {
    const run = await db.saleRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
    try {
      await work(run, await deps.gatewayFor(run.sale.shop));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.saleRun.update({ where: { id: runId }, data: { error: message } });
      throw error;
    }
  }

  return {
    async tick() {
      const now = deps.now();
      const sales = await db.sale.findMany({
        where: { status: { in: ["SCHEDULED", "ACTIVE"] } },
        include: { runs: true },
      });
      for (const sale of sales) {
        const runs = sale.runs.map((r) => ({
          id: r.id,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          open: OPEN_STATUSES.has(r.status),
        }));
        for (const action of dueActions(toScheduleSale(sale), runs, now)) {
          if (action.kind === "start") {
            const run = await createRunIfAbsent(db, sale.id, action.windowStart, action.windowEnd);
            if (run) await deps.send(QUEUES.start, { runId: run.id });
          } else if (action.kind === "stop") {
            await deps.send(QUEUES.stop, { runId: action.runId });
          } else {
            await db.sale.update({ where: { id: sale.id }, data: { status: "ENDED" } });
          }
        }
        if (sale.autoRefresh) {
          for (const run of sale.runs) {
            const last = (run.lastRefreshedAt ?? run.startedAt)?.getTime();
            if (run.status === "ACTIVE" && last !== undefined && now.getTime() - last >= REFRESH_INTERVAL_MS) {
              await deps.send(QUEUES.refresh, { runId: run.id });
            }
          }
        }
      }
    },

    async startRun(runId: string) {
      await withRun(runId, async (run, gateway) => {
        const prepared = await prepareRun(db, gateway, runId);
        if (prepared.status === "overlap") return;
        const current = await db.saleRun.findUniqueOrThrow({ where: { id: runId } });
        if (current.status !== "APPLYING" && current.status !== "ACTIVE") return;
        await applyRun(db, gateway, runId);
        await db.sale.update({ where: { id: run.saleId }, data: { status: "ACTIVE" } });
      });
    },

    async stopRun(runId: string) {
      await withRun(runId, async (_run, gateway) => {
        await restoreRun(db, gateway, runId);
      });
    },

    async refreshRun(runId: string) {
      await withRun(runId, async (_run, gateway) => {
        await refreshRun(db, gateway, runId);
      });
    },
  };
}

function toScheduleSale(sale: Sale): ScheduleSale {
  return {
    scheduleKind: sale.scheduleKind as ScheduleKind,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    recurring: (sale.recurring as unknown as RecurringSchedule | null) ?? null,
    timezone: sale.timezone,
  };
}

async function createRunIfAbsent(db: PrismaClient, saleId: string, windowStart: Date, windowEnd: Date | null) {
  try {
    return await db.saleRun.create({ data: { saleId, windowStart, windowEnd } });
  } catch (error) {
    // Unique (saleId, windowStart): another tick already created this run.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:int -- app/jobs`
Expected: PASS (4 tests).

Run: `npm run test:int && npm test && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Add the worker entry point**

Create `app/worker.ts`:

```ts
import PgBoss from "pg-boss";
import prisma from "./db.server";
import { createJobHandlers, QUEUES } from "./jobs/handlers";
import { unauthenticated } from "./shopify.server";
import { adminGraphql, createGraphqlGateway } from "./shopify/graphql-gateway";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error("[pg-boss]", error));
await boss.start();
for (const name of Object.values(QUEUES)) await boss.createQueue(name);

const handlers = createJobHandlers({
  db: prisma,
  now: () => new Date(),
  gatewayFor: async (shop) => {
    const { admin } = await unauthenticated.admin(shop);
    return createGraphqlGateway(adminGraphql(admin));
  },
  send: async (queue, data) => {
    // singletonKey: never two queued jobs for the same run on the same queue.
    await boss.send(queue, data, { singletonKey: data.runId, retryLimit: 5, retryBackoff: true });
  },
});

type RunJob = { data: { runId: string } };

await boss.work(QUEUES.tick, async () => handlers.tick());
await boss.work<RunJob["data"]>(QUEUES.start, async ([job]) => handlers.startRun(job.data.runId));
await boss.work<RunJob["data"]>(QUEUES.stop, async ([job]) => handlers.stopRun(job.data.runId));
await boss.work<RunJob["data"]>(QUEUES.refresh, async ([job]) => handlers.refreshRun(job.data.runId));
await boss.schedule(QUEUES.tick, "* * * * *");

console.log("Sale worker started");
```

Run: `npx tsc --noEmit`
Expected: no errors. (If pg-boss 10's typings differ from `work<T>(name, handler)` / `([job])`, adapt the calls to its exported `WorkHandler` type and ledger the ruling.)

- [ ] **Step 6: Commit**

```bash
git add app/jobs app/worker.ts package.json
git commit -m "feat: add sale job handlers and pg-boss worker"
```

---

### Task 11: Dev-store verification and the uninstall spike (with you)

This task needs your Shopify account; the agent prepares everything and walks you through the steps that need a login.

**Files:**
- Create: `scripts/dev-sale.ts`, `docs/superpowers/spikes/2026-10-08-sale-engine-dev-store.md`

- [ ] **Step 1: Write the dev-sale script**

Create `scripts/dev-sale.ts`:

```ts
// Creates a one-time sale for manual testing, e.g.:
// npx tsx scripts/dev-sale.ts --shop my-dev.myshopify.com --collection gid://shopify/Collection/123 --percent 30 --minutes 10
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    collection: { type: "string" },
    percent: { type: "string", default: "30" },
    minutes: { type: "string", default: "10" },
    tag: { type: "string" },
    timezone: { type: "string", default: "Asia/Jakarta" },
  },
});
if (!values.shop || !values.collection) {
  throw new Error("Usage: --shop <domain> --collection <gid> [--percent 30] [--minutes 10] [--tag sale]");
}

const db = new PrismaClient();
const startsAt = new Date();
const endsAt = new Date(startsAt.getTime() + Number(values.minutes) * 60_000);
const sale = await db.sale.create({
  data: {
    shop: values.shop,
    title: `Dev sale ${startsAt.toISOString()}`,
    status: "SCHEDULED",
    timezone: values.timezone!,
    priceBase: "compareAt",
    rounding: { kind: "roundDown", step: 100_000 },
    tagsToAdd: values.tag ? [values.tag] : [],
    tagsToRemove: [],
    scheduleKind: "once",
    startsAt,
    endsAt,
    ruleGroups: {
      create: [{
        position: 0,
        priority: 1,
        amountType: "percentOff",
        amount: Number(values.percent),
        targets: [{ kind: "collection", id: values.collection }],
        exclusions: [],
      }],
    },
  },
});
console.log(`Created sale ${sale.id}: ${values.percent}% off until ${endsAt.toISOString()}`);
await db.$disconnect();
```

Run: `npx tsc --noEmit`
Expected: no errors. Commit:

```bash
git add scripts/dev-sale.ts
git commit -m "chore: add dev-sale script for manual store testing"
```

- [ ] **Step 2: You — link the app and install it on a development store**

```bash
npm run config:link
npm run dev
```

Sign in, create or choose the app, pick a development store, and install the app when the CLI opens it. Import the client's product catalog (Shopify admin → Products → Import, CSV) or create at least one collection with **1,000+ variants**.

- [ ] **Step 3: Configure and start the worker**

```bash
npm run env -- show
```

Copy `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` into `.env`. With `npm run dev` still running, in a second terminal:

```bash
npm run worker
```

Expected: `Sale worker started`.

- [ ] **Step 4: Run the checks and record results**

For each, record pass/fail and observations in `docs/superpowers/spikes/2026-10-08-sale-engine-dev-store.md`:

1. **Small sale:** `npx tsx scripts/dev-sale.ts --shop <shop> --collection <small collection gid> --percent 30 --minutes 5 --tag sale`. Within a minute, prices drop with crossed-out originals and the `sale` tag appears; after 5 minutes, prices and tags are back.
2. **Large sale timing:** same with the 1,000+ variant collection. Record how long the apply takes (`SaleRun.startedAt` minus the run's creation in the logs). If over ~5 minutes, flag "bulk operations needed" for a follow-up task.
3. **Crash recovery:** start another large sale, stop the worker (Ctrl+C) partway through applying, restart it. Expected: it finishes; `PriceChangeLog` has exactly one `apply` row per variant.
4. **Manual edit conflict:** during a sale, change one variant's price in Shopify admin. After the sale ends, that variant keeps your price and its snapshot is `CONFLICT`.
5. **Uninstall spike (spec §11.2):** start a sale, then uninstall the app while it is active. Reinstall the app and query one sale variant in GraphiQL (`shopify app dev` → press `g`):

```graphql
{ productVariant(id: "gid://shopify/ProductVariant/<id>") { price compareAtPrice metafield(namespace: "$app", key: "sale_state") { value } } }
```

Record whether the `sale_state` value survived. This decides how Plan 5 handles reinstall recovery. Afterwards, restore the prices with `recoverFromMetafields` if the marker survived, or by hand from the CSV/`PriceChangeLog` if not.

- [ ] **Step 5: Commit the results**

```bash
git add docs/superpowers/spikes/2026-10-08-sale-engine-dev-store.md
git commit -m "docs: record sale engine dev-store verification and uninstall spike"
```

---

## Spec coverage

| Spec section | Covered by |
|---|---|
| §3 Postgres + Prisma, pg-boss | Tasks 1, 2, 10 |
| §5.1 Data model | Task 2 (+ `RunProduct` for tags) |
| §5.2 One active sale per variant | Task 5 (DB overlap) + marker check in `planForSale` |
| §5.2 Auto-refresh | Tasks 8, 10 |
| §5.3 Price calculation | Task 3 (reuses Plan 1 calculator) |
| §5.4 Apply flow: transaction, count check, markers, idempotent retries | Tasks 5, 6 |
| §5.5 Restore, conflicts, metafield fallback | Task 7 (reinstall wiring → Plan 5) |
| §5.6 Scheduling, missed starts | Tasks 9, 10 |
| §5.7 Safety net 1–4, 7 | Tasks 5–7; 5 (backups) is hosting, Plan 5; 6 (CSV download) is UI, Plan 3 |
| §9 Rate limits, retries | Task 4 (`withThrottleRetry`), Task 10 (pg-boss retries) |
| §10 Integration tests on dev store | Task 11 |
| §11.2 Uninstall spike | Task 11 |
| Deferred | Bulk operations (pending Task 11 timing), `products/update` webhook (Plan 3), notifications (Plan 5) |
