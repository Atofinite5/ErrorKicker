import { getPath, type RuleDef } from "./rules.ts";

// ---------------------------------------------------------------------------
// Fix Suggestion Engine — rule templates first, LLM second.
// Templates are deterministic: the demo never depends on an AI API being up.
// Every fix is re-run through the full gate before committing (no back door).
// ---------------------------------------------------------------------------

export type FixSource = "rule-template" | "llm" | "none";

export interface FixSuggestion {
  /** The corrected record, or null when no safe automatic fix exists. */
  fixedRecord: Record<string, unknown> | null;
  explanation: string;
  fixSource: FixSource;
  fixConfidence: number;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

/** Nearest known field within edit distance 2 — the "emial → email" fix. */
export function nearestField(unknownKey: string, known: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const k of known) {
    const d = levenshtein(unknownKey.toLowerCase(), k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

/**
 * PRD §15 default (editable fields): an edit-approve candidate may only use
 * fields that already exist in the original record or in the proposed fix —
 * editing changes values, it never adds brand-new fields. Returns the list
 * of added (disallowed) field names; empty list = edit is in bounds.
 * Pure — unit-tested in smoke.
 */
export function addedFields(
  candidate: Record<string, unknown>,
  ...allowedSources: Array<Record<string, unknown> | null | undefined>
): string[] {
  const allowed = new Set<string>();
  for (const src of allowedSources) {
    if (src) for (const k of Object.keys(src)) allowed.add(k);
  }
  return Object.keys(candidate).filter((k) => !allowed.has(k));
}

export function suggestFix(opts: {
  table: string;
  record: Record<string, unknown>;
  checkFired: string;
  rule?: RuleDef | null;
  value?: unknown;
  unknownKeys?: string[];
  knownFields?: string[];
  baseline?: { min: number; max: number } | null;
}): FixSuggestion {
  const { record, checkFired, rule, value, unknownKeys, knownFields, baseline } = opts;
  const none = (explanation: string): FixSuggestion => ({
    fixedRecord: null,
    explanation,
    fixSource: "none",
    fixConfidence: 0,
  });

  // A3 — typo'd field name: rename to the nearest known field.
  if (checkFired === "A3_EXTRA" && unknownKeys?.length && knownFields?.length) {
    const typo = unknownKeys[0];
    const target = nearestField(typo, knownFields);
    if (target) {
      const fixed = { ...record };
      fixed[target] = fixed[typo];
      delete fixed[typo];
      return {
        fixedRecord: fixed,
        explanation: `Field "${typo}" looks like a typo of "${target}". Renamed it — verify the value is meant for that field.`,
        fixSource: "rule-template",
        fixConfidence: 0.88,
      };
    }
  }

  // B4 — out of range.
  // Negative with a zero floor is the classic sign-flip (-499 → 499):
  // clamping it to 0 would silently zero the order. Otherwise clamp to the
  // nearest valid bound.
  if (checkFired.startsWith("B4") && rule?.check === "range" && typeof value === "number") {
    const lo = baseline?.min ?? rule.min ?? 0;
    const hi = baseline?.max ?? rule.max ?? Number.MAX_SAFE_INTEGER;
    let fixedValue: number;
    let how: string;
    if (value < 0 && lo === 0) {
      fixedValue = Math.min(Math.abs(value), hi);
      how = `it looks like a sign slip, so it was flipped to ${fixedValue}`;
    } else {
      fixedValue = Math.min(Math.max(value, lo), hi);
      how = `clamped to the nearest valid value (${fixedValue})`;
    }
    const fixed = { ...record, [rule.field!]: fixedValue };
    const rangeTxt =
      baseline != null
        ? `every valid ${opts.table} record recently seen is between ${inr(baseline.min)} and ${inr(baseline.max)}`
        : `valid values are between ${inr(lo)} and ${inr(hi)}`;
    return {
      fixedRecord: fixed,
      explanation: `${rule.field} is ${value}, which is outside the valid range — ${rangeTxt}. ${how[0].toUpperCase()}${how.slice(1)}.`,
      fixSource: "rule-template",
      fixConfidence: 0.92,
    };
  }

  // B5 — total doesn't match line items: recompute from the lines.
  if (checkFired === "B5_TOTAL_MATCHES_LINES") {
    const items = getPath(record, "items");
    if (Array.isArray(items)) {
      const sum = items.reduce(
        (t: number, it: unknown) =>
          t +
          (typeof (it as Record<string, unknown>).qty === "number" &&
          typeof (it as Record<string, unknown>).price === "number"
            ? (it as { qty: number; price: number }).qty *
              (it as { qty: number; price: number }).price
            : 0),
        0,
      );
      const rounded = Math.round(sum * 100) / 100;
      return {
        fixedRecord: { ...record, total: rounded },
        explanation: `Order total (${(record as Record<string, unknown>).total}) does not match the sum of its line items (${rounded}). Recomputed the total from the lines.`,
        fixSource: "rule-template",
        fixConfidence: 0.9,
      };
    }
  }

  // B8 — inverted dates: swap them.
  if (checkFired === "B8_DELIVERY_ORDER" && rule?.field && rule?.other) {
    const a = record[rule.field];
    const b = record[rule.other];
    return {
      fixedRecord: { ...record, [rule.field]: b, [rule.other]: a },
      explanation: `${rule.other} (${b}) is before ${rule.field} (${a}) — the dates look swapped. Swapped them back.`,
      fixSource: "rule-template",
      fixConfidence: 0.85,
    };
  }

  // Cases with no safe automatic fix — explain, recommend the human action.
  if (checkFired === "C7_EXACT_DUPLICATE")
    return none(
      "This record is byte-identical to one submitted moments ago — a double-submit. Safe to reject; nothing is lost.",
    );
  if (checkFired === "D11_SUSPICIOUS_PATTERN")
    return none(
      "A text field matches a known injection / script pattern. Do not auto-fix — reject the record and check the source form.",
    );
  if (checkFired === "B6_USER_EXISTS")
    return none(
      `Customer "${value}" does not exist in the database — the order would be orphaned. Pick the correct customer or create them first.`,
    );

  return none(
    rule?.message ??
      "No automatic fix is known for this failure. Edit the record by hand or reject it.",
  );
}
