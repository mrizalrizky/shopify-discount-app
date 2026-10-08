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
