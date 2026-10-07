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
      if (!Number.isSafeInteger(rule.step) || rule.step <= 0) {
        throw new Error("roundDown step must be a positive integer");
      }
      return Math.floor(amount / rule.step) * rule.step;
    case "endsWith":
      if (
        !Number.isSafeInteger(rule.modulus) ||
        !Number.isSafeInteger(rule.ending) ||
        rule.modulus <= 0 ||
        rule.ending < 0 ||
        rule.ending >= rule.modulus
      ) {
        throw new Error("endsWith requires integers with 0 <= ending < modulus");
      }
      return Math.floor((amount - rule.ending) / rule.modulus) * rule.modulus + rule.ending;
  }
}
