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
