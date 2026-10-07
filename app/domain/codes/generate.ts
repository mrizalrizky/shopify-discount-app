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
