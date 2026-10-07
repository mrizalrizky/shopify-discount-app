# Shopify Sale & Discount Codes App — Design Spec

- **Date:** 2026-10-08
- **Status:** Draft, awaiting review
- **Working title:** TBD by owner (referred to as "the app")

## 1. Purpose

A public Shopify app that replaces two separate apps merchants currently combine:

- **Sales & Discounts**: storefront sales with crossed-out ("compare-at") prices.
- **DiscountFix**: bulk discount-code creation.

**First customer:** a fashion store (Gaudi Clothing) that runs new promotions monthly and sometimes needs custom codes from a list it already has. Not on Shopify Plus. Single currency (IDR). 500+ codes per campaign.

**Success criteria:**
- The first customer runs a monthly sale **and** its codes from one app and uninstalls both existing apps.
- The app is listed publicly on the Shopify App Store and sellable to other merchants.

**Pain points addressed:**
- DiscountFix Free caps at 250 codes/month; the client's campaigns need 500+.
- Sales & Discounts only supports percentage-off sales.
- Excluding sale items from codes is a manual workaround in Sales & Discounts.
- Two apps, two subscriptions, two UIs.

## 2. Scope

### In v1
- **Sale engine:** crossed-out-price sales with flexible targeting, three amount types, scheduling (one-time and recurring), auto-refresh, rounding, minimum price, tagging, safe apply/restore.
- **Code engine:** native or Function-backed code discounts; import or generate 500+ codes per campaign; usage limits; CSV export.
- **Integration:** per-campaign "allow on sale items" setting, enforced by a Shopify Function using markers set by the sale engine.
- **Billing** through Shopify Managed Pricing.

### Out of v1 (v2+)
- Buy X Get Y, spending tiers, maximum discount cap, item limit per order
- Subscription purchase type, customer-tag check at checkout, first-order-only, market targeting
- Shopify Markets / multi-currency price lists
- Countdown timer and custom sale labels (theme app extension)
- Stats and analytics, Shopify Flow integration
- Stacking multiple sales on the same variant
- Compatibility mode for free-gift apps

## 3. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| App framework | Shopify's official React Router app template (Shopify CLI) |
| Admin UI | Polaris, embedded in Shopify admin |
| Shopify API | GraphQL Admin API only |
| Database | PostgreSQL + Prisma |
| Background jobs | pg-boss (Postgres-backed queue) |
| Discount Function | TypeScript → Wasm via Shopify CLI (Rust as fallback if instruction limits are hit) |
| Testing | Vitest; Shopify development store for end-to-end |
| Monitoring | Sentry + structured logs |
| Hosting | Render or Fly.io: web service, worker process, managed Postgres **with point-in-time recovery** |

Exact versions are pinned at scaffold time.

## 4. Architecture

```
            ┌───────────────────────── Shopify Admin (embedded) ─────────────────────────┐
            │  Admin UI (Polaris): Home · Sales · Code campaigns · Settings              │
            └───────────────┬────────────────────────────────────────────────────────────┘
                            │
                ┌───────────▼───────────┐         ┌──────────────────────┐
                │  Web service (React   │ enqueue │  Worker (pg-boss)    │
                │  Router app + API)    ├────────►│  - sale start/stop   │
                └───────────┬───────────┘         │  - auto-refresh      │
                            │                     │  - code batch adds   │
                            ▼                     └──────────┬───────────┘
                     ┌─────────────┐                         │
                     │ PostgreSQL  │◄────────────────────────┘
                     └─────────────┘
                            ▲ webhooks                 GraphQL Admin API
                            │                                 │
            ┌───────────────┴─────────────────────────────────▼──────────────────┐
            │ Shopify: products/variants, discounts, metafields, Discount Function│
            └────────────────────────────────────────────────────────────────────┘
```

**Components:**

1. **Admin UI:** embedded app with Home, Sales, Code campaigns, Settings.
2. **Sale engine:**
   - **Resolver:** rule groups → final variant list, settling overlaps.
   - **Calculator:** computes sale prices.
   - **Applier:** snapshots originals, then writes prices and markers.
   - **Restorer:** writes originals back and removes markers.
3. **Scheduler (pg-boss):** start and stop jobs, recurring expansion, auto-refresh, retries.
4. **Code engine:** creates discounts, imports or generates codes, adds codes in batches, exports.
5. **Discount Function:** used only by campaigns that exclude sale items.
6. **PostgreSQL:** all app state, including price snapshots and an append-only change log.
7. **Webhooks:**
   - `app/uninstalled`
   - mandatory GDPR webhooks
   - discount update/delete
   - `products/update` (detects manual price edits during sales)

## 5. Sale engine

### 5.1 Data model

- **Sale:**
  - `id`, `shopId`, `title`
  - `status`: draft / scheduled / active / ending / ended / failed
  - `priceBase`: compareAt | current (default: compareAt)
  - `rounding`: none | roundDown(step) | endsWith(value), e.g. down to Rp1.000, or ending in 900
  - `minPrice` (optional)
  - `tagsToAdd[]`, `tagsToRemove[]`
  - `schedule`: none (manual), once {start, end}, or recurring {weekdays[], startTime, stopTime, firstDate, lastDate}
  - `autoRefresh` (bool), `endBehavior`: always restores pre-sale values
- **RuleGroup:**
  - `saleId`, `priority`
  - `amountType`: percentOff | fixedOff | fixedPrice
  - `amount`
  - `targets[]` (collection / product / variant IDs), `exclusions[]` (product / variant IDs)
- **SaleRun:** one occurrence of a Sale (one-time sale = 1 run; recurring = 1 run per window). Fields: `status`, `startedAt`, `endedAt`.
- **PriceSnapshot:** one row per variant per run.
  - `runId`, `variantId`, `productId`
  - `originalPrice`, `originalCompareAt`, `appliedPrice`, `appliedCompareAt`
  - `status`: pending / applied / restored / conflict
- **PriceChangeLog:** append-only record of every price write (old value, new value, sale, run, timestamp).

### 5.2 Targeting and overlap

- A sale has one or more rule groups. Each group targets any mix of collections, products, and variants, minus its exclusions.
- **Precedence within a sale:** most specific target wins (variant > product > collection). Between collections, the lower `priority` number wins.
- **Across sales (v1):** a variant may belong to **only one active sale at a time**. Starting or scheduling a sale whose variants overlap another active or scheduled sale is blocked, and the overlapping products are listed.
- **Collection resolution:** collections are resolved when a run starts. With `autoRefresh`, the worker re-resolves periodically (every 20 minutes) during the run, adds variants that newly match, and restores variants that no longer match.

### 5.3 Price calculation (per variant)

1. **Base price:**
   - if `priceBase = compareAt` and `compareAt > price`, the base is `compareAt`
   - otherwise the base is `price`
2. **New price:**
   - `percentOff`: base × (1 − p)
   - `fixedOff`: base − x
   - `fixedPrice`: x
3. **Rounding:** apply the rounding rule.
4. **Minimum price:** if the result is below `minPrice`, raise it to `minPrice`.
5. **Skip rule:** if the result is ≥ the current `price`, skip the variant and record the reason. A sale never raises a price.
6. **Crossed-out price:**
   - the original `compareAt`, if present and greater than the new price
   - otherwise the original `price`

### 5.4 Apply flow (safety-critical)

1. Resolve the variants and compute prices.
2. **Write all snapshots in a single DB transaction** (status `pending`). If the transaction fails, nothing is written and Shopify is not touched; the job retries, then marks the sale `failed` and notifies the merchant.
3. **Count check:** the snapshot count must equal the resolved variant count, or the run aborts before any Shopify write.
4. Write to Shopify in batches:
   - **Up to ~1,000 variants:** `productVariantsBulkUpdate` per product.
   - **Larger runs:** Shopify bulk mutation operations.
   - **Each variant write sets:**
     - new price and compare-at price
     - app-owned metafield `on_sale` = sale ID (the marker the Function reads)
     - app-owned metafield with the **original price and compare-at price** (second copy of the snapshot)
5. Mark snapshots `applied` per successful batch. Apply product tags.
6. **Retries are idempotent.** Only `pending` snapshots are processed. If Shopify already shows the applied price for a `pending` snapshot (for example after a crash between the Shopify write and the DB update), mark it `applied` without writing again.

### 5.5 Restore flow

For each `applied` snapshot:
- If the current Shopify price **equals** `appliedPrice`, write back `originalPrice` and `originalCompareAt`, remove the markers, and mark the snapshot `restored`.
- If it **differs** (edited by hand during the sale), **do not overwrite**. Mark the snapshot `conflict` and list it in the UI with "restore anyway" or "keep current price."
- If a DB snapshot is missing or unreadable, fall back to the original-price metafield on the variant.

Then remove the product tags.

### 5.6 Scheduling

- **Timezone:** always the shop's timezone (from Shopify), never the browser's.
- **Recurring:** a daily start/stop window on selected weekdays between `firstDate` and `lastDate`. Each window is a full apply → restore cycle (one SaleRun). Windows that cross midnight (e.g. 22:00–02:00) are supported.
- **Missed starts:** the scheduler runs every minute. A late start is applied only if its window is still open. A missed stop always restores as soon as possible.

### 5.7 Safety net summary

1. All-or-nothing snapshot transaction before any Shopify write
2. Count check before applying
3. Original prices copied into a variant metafield in Shopify
4. Idempotent retries that reconcile against Shopify's current price
5. Managed Postgres with daily backups and point-in-time recovery
6. Merchant-downloadable CSV of original prices (offered in the preview)
7. Append-only price change log

## 6. Code engine

### 6.1 Data model

- **CodeCampaign:**
  - `id`, `shopId`, `title`, `label` (campaign grouping)
  - `shopifyDiscountId`, `mode`: native | function
  - `discountType`: percentage | fixedAmount | freeShipping
  - `value`, `appliesTo`: all | collections[] | products[]
  - `allowOnSaleItems`: bool, **locked after creation**
  - `minRequirement`: none | minAmount | minQuantity
  - `eligibility`: all | segments[]
  - `usesPerCode` (null = unlimited), `oncePerCustomer` (bool)
  - `combinesWith`: {product, order, shipping}
  - `startsAt`, `endsAt?`, `status`
- **CodeBatch:** `campaignId`, `source`: import | generate, `count`, `status`.
- **Code:** `campaignId`, `batchId`, `code`, `status`: pending / added / failed, `failureReason?`.

### 6.2 Discount type selection

| Condition | Shopify discount created |
|---|---|
| `freeShipping` | Native free-shipping code discount |
| `allowOnSaleItems = true` | Native basic code discount (editable in Shopify admin) |
| `allowOnSaleItems = false` | App code discount backed by the Discount Function |

Changing `allowOnSaleItems` after creation is not allowed. The UI offers "duplicate with the other setting" instead.

### 6.3 Creation flow

1. Validate the codes:
   - Shopify's allowed characters and length
   - duplicates within the list
   - codes already in the app's DB for this shop
2. Save all codes to the DB as `pending`.
3. **The app creates the Shopify discount using the first code** (Shopify requires one code at creation). The merchant never creates anything in Shopify manually.
4. Add the remaining codes in **batches of 250** via the bulk-add API. Poll each batch result and mark each code `added` or `failed` with the reason (e.g. the code already exists on another discount in the shop).
5. Show failures, with "fix and retry" and "skip." Codes are never dropped silently.

### 6.4 Random code generator

- Options: **prefix** (e.g. `GDI23-OL`), random-part length, character set (letters / numbers / both), and "exclude look-alikes" (0/O, 1/I/L).
- Every generated code is checked against existing codes. Collisions are regenerated.
- If the requested count is a large share of the possible combinations, the app warns and suggests a longer random part.

### 6.5 Usage limits

- `usesPerCode` applies **per code** (confirmed by DiscountFix-created discounts showing "Used 0/1" per code; to be re-verified in a spike).
- `oncePerCustomer` uses Shopify's native once-per-customer setting.

### 6.6 Discount Function

- Configuration (type, value, targets) is stored in a metafield on the app discount.
- At checkout:
  - For each cart line, skip the line if its variant has the `on_sale` marker.
  - Otherwise apply the configured discount, matching native semantics.
- Because the marker is removed when a sale ends, those items become eligible again without any change to the campaign.

### 6.7 Sync and export

- Discount update and delete webhooks keep the app's records of **native** discounts in sync with edits made in Shopify admin.
- **CSV export:** code, status, Shopify usage count.

## 7. Admin UI

1. **Home**
   - active and upcoming sales and campaigns
   - alerts: conflicts, failed jobs, codes that failed to add
   - **"End all sales and restore prices"**
2. **Sales list → Sale editor**
   - rule groups: Shopify resource picker for targets and exclusions, plus amount type and value
   - price base, rounding, minimum price, tags, schedule, auto-refresh
   - summary sidebar
3. **Sale preview (required before start or schedule)**
   - per-variant table: current price → new price, crossed-out price
   - skipped variants with reasons, overlaps
   - download of original prices as CSV
4. **Sale detail**
   - live progress and run history
   - conflict resolution (restore anyway / keep current price) and **End now**
5. **Code campaigns list → Campaign editor**
   - settings laid out like Shopify's native discount form
   - codes step: upload CSV, paste, or generate (with a live example code)
   - progress view, failure list, CSV export
6. **Settings:** shop timezone (read-only), default rounding, notification email, plan

## 8. Billing (Shopify Managed Pricing)

| | Development stores | Basic | Pro |
|---|---|---|---|
| Price | Free | US$9.99/mo | US$19.99/mo |
| Yearly | — | ~17% off | ~17% off |
| Trial | — | 14 days | 14 days |
| Discounted variants | Full Pro | 10,000 / 30 days | Unlimited |
| Codes | Full Pro | 10,000 / month | Unlimited |
| Scheduling | Full Pro | One-time | One-time + recurring |
| Auto-refresh | Full Pro | No | Yes |
| Exclude sale items from codes | Full Pro | Yes | Yes |

- There is no free plan for production stores.
- Plan limits live in a config file, not hard-coded.
- **Ending a sale and restoring prices are never blocked by billing state** (trial ended, cancelled, downgraded). Billing limits only block creating or starting new sales and campaigns.

**Competitive reference (as of 2026-10-08):**
- Sales & Discounts: Premium $9.99, Premium Plus $24.99
- DiscountFix: Premium $2.99, Pro $4.99, Unlimited $14.99
- Typical combined cost: $12.98–$39.98/mo

## 9. Error handling

- **Shopify rate limits:** read the throttle status in each GraphQL response and pace requests; exponential backoff on failures.
- **Jobs:** idempotent, with automatic retries. When retries are exhausted, mark the item `failed`, alert in the app, and email the merchant.
- **Uninstall:** Shopify revokes access immediately, so prices cannot be restored after uninstall.
  - The app warns prominently: "end all sales before uninstalling."
  - On uninstall, stop all jobs and keep snapshots for 30 days.
  - On reinstall within 30 days, offer to restore.
- **Manual price edits during a sale:** detected via the `products/update` webhook and at restore time; surfaced as conflicts and never overwritten silently.
- **Monitoring:** Sentry for errors, structured logs, and an internal page showing job status.

## 10. Testing

- **Unit tests (Vitest):**
  - **Price calculator:** all amount types × both price bases, rounding rules, minimum price, skip rule
  - **Resolver:** precedence and overlap detection
  - **Recurring schedule expansion:** midnight-crossing windows, Asia/Jakarta, plus a DST timezone
  - **Code generator and validator:** charset, look-alikes, collisions, capacity warning
- **Function tests:** cart fixtures with mixed on-sale and regular items, for each discount type.
- **Integration tests (development store with the client's catalog imported):**
  - apply and restore a sale on 1,000+ variants
  - kill the worker mid-apply, verify recovery and no double-apply
  - edit a price by hand mid-sale, verify a conflict is raised
  - bulk-add 500+ codes including in-list and cross-discount duplicates
- **Pilot:** run the client's next promotion in parallel with the existing apps before switching.

## 11. Pre-build verification spikes

1. Confirm that `usesPerCode` is enforced per code on a discount with multiple codes.
2. Confirm whether app-owned metafields survive app uninstall (this determines whether the metafield copy also helps after a reinstall).
3. Confirm that the Discount Function can read a variant metafield on cart lines within instruction limits for large carts.
