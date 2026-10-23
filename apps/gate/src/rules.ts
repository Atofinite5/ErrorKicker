import { parse as parseYaml } from "yaml";
import { appTable, pool } from "./db.ts";

// ---------------------------------------------------------------------------
// Stage B: business rules as data (YAML). First failing rule kicks the record.
// The expression check uses a tiny sandboxed evaluator — no eval(), no
// Function(), only numbers, field paths, comparisons and abs()/sum().
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "info";

export interface RuleDef {
  id: string;
  severity: Severity;
  message: string;
  check:
    | "range"
    | "expression"
    | "exists"
    | "regex"
    | "not_future"
    | "each"
    | "length"
    | "date_order";
  field?: string;
  other?: string;
  min?: number;
  max?: number;
  expr?: string;
  table?: string;
  pattern?: string;
  rule?: RuleDef;
}

export interface RuleFailure {
  rule: RuleDef;
  value: unknown;
  message: string;
}

/** Dotted-path lookup: "items.0.qty". Returns undefined when missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// --- safe expression evaluator --------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\s*([0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_.]*|<=|>=|==|!=|[<>\+\-\*\/\(\),])/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(src)) !== null) {
    pos = re.lastIndex;
    const s = m[1];
    if (/^[0-9]/.test(s)) toks.push({ t: "num", v: Number(s) });
    else if (/^[A-Za-z_]/.test(s)) toks.push({ t: "ident", v: s });
    else toks.push({ t: "op", v: s });
  }
  if (pos !== src.length) throw new Error(`bad expression near: ${src.slice(pos)}`);
  return toks;
}

type ExprNode =
  | { k: "num"; v: number }
  | { k: "ident"; name: string }
  | { k: "bin"; op: string; l: ExprNode; r: ExprNode }
  | { k: "neg"; e: ExprNode }
  | { k: "call"; name: string; args: ExprNode[] };

function parseExpr(src: string): ExprNode {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v?: string) => {
    const t = toks[i++];
    if (!t || (v !== undefined && (t.t !== "op" || t.v !== v)))
      throw new Error(`unexpected token in expression: ${src}`);
    return t;
  };
  const parseComparison = (): ExprNode => {
    let l = parseAdditive();
    const t = peek();
    if (t?.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(t.v)) {
      i++;
      l = { k: "bin", op: t.v, l, r: parseAdditive() };
    }
    return l;
  };
  const parseAdditive = (): ExprNode => {
    let l = parseMultiplicative();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        i++;
        l = { k: "bin", op: t.v, l, r: parseMultiplicative() };
      } else return l;
    }
  };
  const parseMultiplicative = (): ExprNode => {
    let l = parseUnary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        i++;
        l = { k: "bin", op: t.v, l, r: parseUnary() };
      } else return l;
    }
  };
  const parseUnary = (): ExprNode => {
    const t = peek();
    if (t?.t === "op" && t.v === "-") {
      i++;
      return { k: "neg", e: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): ExprNode => {
    const t = eat();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = parseComparison();
      eat(")");
      return e;
    }
    if (t.t === "ident") {
      const n = peek();
      if (n?.t === "op" && n.v === "(") {
        i++;
        const args: ExprNode[] = [];
        if (!(peek()?.t === "op" && peek()?.v === ")")) {
          args.push(parseComparison());
          while (peek()?.t === "op" && peek()?.v === ",") {
            i++;
            args.push(parseComparison());
          }
        }
        eat(")");
        return { k: "call", name: t.v, args };
      }
      return { k: "ident", name: t.v };
    }
    throw new Error(`unexpected token in expression: ${src}`);
  };
  const root = parseComparison();
  if (i !== toks.length) throw new Error(`trailing tokens in expression: ${src}`);
  return root;
}

function evalNode(n: ExprNode, scope: unknown, root: unknown): number | boolean {
  switch (n.k) {
    case "num":
      return n.v;
    case "ident": {
      const v =
        getPath(scope, n.name) ?? (scope !== root ? getPath(root, n.name) : undefined);
      return typeof v === "number" ? v : NaN;
    }
    case "neg": {
      const e = evalNode(n.e, scope, root);
      return typeof e === "number" ? -e : NaN;
    }
    case "bin": {
      const l = evalNode(n.l, scope, root);
      const r = evalNode(n.r, scope, root);
      if (typeof l !== "number" || typeof r !== "number") return false;
      switch (n.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r === 0 ? NaN : l / r;
        case "<": return l < r;
        case "<=": return l <= r;
        case ">": return l > r;
        case ">=": return l >= r;
        case "==": return l === r;
        case "!=": return l !== r;
        default: return false;
      }
    }
    case "call": {
      if (n.name === "abs" && n.args.length === 1) {
        const v = evalNode(n.args[0], scope, root);
        return typeof v === "number" ? Math.abs(v) : NaN;
      }
      if (n.name === "sum" && n.args.length === 2 && n.args[0].k === "ident") {
        const coll = getPath(root, n.args[0].name);
        if (!Array.isArray(coll)) return NaN;
        let total = 0;
        for (const el of coll) {
          const v = evalNode(n.args[1], el, root);
          if (typeof v !== "number" || Number.isNaN(v)) return NaN;
          total += v;
        }
        return total;
      }
      throw new Error(`unknown function in expression: ${n.name}`);
    }
  }
}

/** Evaluate a rule expression against a record. Non-true results fail the rule. */
export function evalExpression(src: string, record: unknown): boolean {
  return evalNode(parseExpr(src), record, record) === true;
}

// --- message templating -----------------------------------------------------

function renderMessage(
  template: string,
  record: unknown,
  rule: RuleDef,
  value: unknown,
): string {
  return template.replace(/\{([\w.]+)\}/g, (_m, key: string) => {
    if (key === "field") return rule.field ?? "";
    if (key === "value") return JSON.stringify(value);
    if (key === "min") return String(rule.min ?? "");
    if (key === "max") return String(rule.max ?? "");
    if (key === "otherValue") return JSON.stringify(getPath(record, rule.other ?? ""));
    const v = getPath(record, key);
    return v === undefined ? `{${key}}` : JSON.stringify(v);
  });
}

// --- rule loading (versioned, cached) ---------------------------------------

const ruleCache = new Map<string, RuleDef[]>();

export async function loadRules(table: string): Promise<RuleDef[]> {
  const hit = ruleCache.get(table);
  if (hit) return hit;
  const { rows } = await pool.query(
    "SELECT rule_yaml FROM rules_config WHERE table_name = $1 AND active",
    [table],
  );
  if (rows.length === 0) throw new Error(`no active rules for table: ${table}`);
  const parsed = parseYaml(rows[0].rule_yaml as string) as { rules: RuleDef[] };
  ruleCache.set(table, parsed.rules);
  return parsed.rules;
}

export function reloadRules(): void {
  ruleCache.clear();
}

// --- the engine --------------------------------------------------------------

async function evaluateRule(
  table: string,
  record: unknown,
  rule: RuleDef,
): Promise<RuleFailure | null> {
  const fail = (value: unknown): RuleFailure => ({
    rule,
    value,
    message: renderMessage(rule.message, record, rule, value),
  });

  switch (rule.check) {
    case "range": {
      const v = getPath(record, rule.field!);
      if (v === undefined) return null; // optional field absent: not applicable
      if (typeof v !== "number" || v < (rule.min ?? -Infinity) || v > (rule.max ?? Infinity))
        return fail(v);
      return null;
    }
    case "length": {
      const v = getPath(record, rule.field!);
      if (v === undefined) return null;
      if (typeof v !== "string" || v.length < (rule.min ?? 0) || v.length > (rule.max ?? Infinity))
        return fail(v);
      return null;
    }
    case "expression": {
      let ok = false;
      try {
        ok = evalExpression(rule.expr!, record);
      } catch {
        ok = false; // unparseable rule fails closed
      }
      return ok ? null : fail(undefined);
    }
    case "exists": {
      const v = getPath(record, rule.field!);
      if (v === undefined) return null;
      const { rowCount } = await pool.query(
        `SELECT 1 FROM ${appTable(rule.table!)} WHERE id = $1 LIMIT 1`,
        [String(v)],
      );
      return rowCount ? null : fail(v);
    }
    case "regex": {
      const v = getPath(record, rule.field!);
      if (v === undefined) return null;
      if (typeof v !== "string" || !new RegExp(rule.pattern!).test(v)) return fail(v);
      return null;
    }
    case "not_future": {
      const v = getPath(record, rule.field!);
      if (v === undefined) return null;
      const t = typeof v === "string" ? Date.parse(v) : NaN;
      if (Number.isNaN(t) || t > Date.now()) return fail(v);
      return null;
    }
    case "date_order": {
      const a = getPath(record, rule.field!);
      const b = getPath(record, rule.other!);
      if (a === undefined || b === undefined) return null; // optional pair
      const ta = typeof a === "string" ? Date.parse(a) : NaN;
      const tb = typeof b === "string" ? Date.parse(b) : NaN;
      if (Number.isNaN(ta) || Number.isNaN(tb) || ta > tb) return fail(a);
      return null;
    }
    case "each": {
      const arr = getPath(record, rule.field!);
      if (!Array.isArray(arr)) return null; // Stage A owns the type error
      for (let idx = 0; idx < arr.length; idx++) {
        const sub = await evaluateRule(table, arr[idx], rule.rule!);
        if (sub)
          return { ...sub, message: `[item ${idx}] ${sub.message}` };
      }
      return null;
    }
    default:
      return fail(undefined);
  }
}

/** First failing rule wins — rules are ordered cheapest-first in the YAML. */
export async function evaluateRules(
  table: string,
  record: unknown,
  rules: RuleDef[],
): Promise<RuleFailure | null> {
  for (const rule of rules) {
    const failure = await evaluateRule(table, record, rule);
    if (failure) return failure;
  }
  return null;
}
