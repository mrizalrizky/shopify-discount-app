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
