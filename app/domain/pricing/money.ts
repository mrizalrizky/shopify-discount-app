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
