import type { JsonSchema } from "./types";

export type Validation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; hint: string };

interface Issue {
  message: string;
  hint: string;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] as number;
}

/** Closest candidate within a small edit distance, or undefined. */
export function didYouMean(input: string, candidates: ReadonlyArray<string>): string | undefined {
  const lowered = input.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const name of candidates) {
    const score = distance(lowered, name.toLowerCase());
    if (!best || score < best.score) best = { name, score };
  }
  const limit = Math.max(2, Math.floor(input.length / 3));
  return best && best.score <= limit ? best.name : undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
  }
}

function check(schema: JsonSchema, value: unknown, path: string): Issue | null {
  const where = path === "" ? "input" : `"${path}"`;
  if (schema.oneOf && schema.oneOf.length > 0) {
    const failures: Issue[] = [];
    for (const option of schema.oneOf) {
      const issue = check(option, value, path);
      if (!issue) return null;
      failures.push(issue);
    }
    return { message: `${where} does not match any allowed shape`, hint: failures.map((f) => f.message).join(" OR ") };
  }
  if (schema.type && !matchesType(schema.type, value)) {
    const expected = schema.type === "integer" ? "a whole number" : `a ${schema.type}`;
    return { message: `${where} must be ${expected}, got ${describe(value)}`, hint: `Pass ${where} as ${expected}.` };
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    const options = schema.enum.map((v) => JSON.stringify(v)).join(", ");
    const near = typeof value === "string" ? didYouMean(value, schema.enum.map(String)) : undefined;
    return { message: `${where} must be one of ${options}, got ${JSON.stringify(value)}`, hint: near ? `Did you mean "${near}"?` : `Use one of: ${options}.` };
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { message: `${where} must be >= ${schema.minimum}, got ${value}`, hint: `Use a value between ${schema.minimum} and ${schema.maximum ?? "no upper limit"}.` };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { message: `${where} must be <= ${schema.maximum}, got ${value}`, hint: `Use a value between ${schema.minimum ?? "no lower limit"} and ${schema.maximum}.` };
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const issue = check(schema.items, value[i], `${path}[${i}]`);
      if (issue) return issue;
    }
  }
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return checkObject(schema, value as Record<string, unknown>, path);
  }
  return null;
}

function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string): Issue | null {
  const properties = schema.properties;
  const prefix = path === "" ? "" : `${path}.`;
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) {
      const known = Object.keys(properties ?? {});
      const near = Object.keys(value).map((k) => ({ k, guess: didYouMean(k, [key]) })).find((x) => x.guess);
      return {
        message: `Missing required field "${prefix}${key}"`,
        hint: near ? `You passed "${near.k}"; the field is named "${key}".` : `Include "${key}". Fields: ${known.join(", ")}.`,
      };
    }
  }
  if (properties) {
    const known = Object.keys(properties);
    for (const key of Object.keys(value)) {
      if (properties[key] === undefined && schema.additionalProperties !== true) {
        const near = didYouMean(key, known);
        return {
          message: `Unknown field "${prefix}${key}"`,
          hint: near ? `Did you mean "${near}"? Valid fields: ${known.join(", ")}.` : `Valid fields: ${known.join(", ")}.`,
        };
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (value[key] === undefined) continue;
      const issue = check(sub, value[key], `${prefix}${key}`);
      if (issue) return issue;
    }
  }
  return null;
}

/** Validates tool input against its schema. Missing input counts as `{}`. Unknown keys are rejected. */
export function validateInput(schema: JsonSchema, input: unknown): Validation {
  const value = input === undefined || input === null ? {} : input;
  const issue = check(schema, value, "");
  if (issue) return { ok: false, error: issue.message, hint: issue.hint };
  return { ok: true, value: value as Record<string, unknown> };
}
