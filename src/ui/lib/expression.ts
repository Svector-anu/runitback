/** Evaluates + - * / and parentheses without `eval`. Returns null for anything else. */
export function evaluateExpression(input: string): number | null {
  const text = input.replace(/\s+/g, "").replace(/,/g, ".");
  if (text === "") return null;
  let pos = 0;

  const peek = (): string | undefined => text[pos];
  const parseNumber = (): number | null => {
    const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return Number(m[0]);
  };
  const parseFactor = (): number | null => {
    const c = peek();
    if (c === "-") { pos++; const v = parseFactor(); return v === null ? null : -v; }
    if (c === "+") { pos++; return parseFactor(); }
    if (c === "(") {
      pos++;
      const v = parseSum();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    return parseNumber();
  };
  const parseProduct = (): number | null => {
    let left = parseFactor();
    while (left !== null && (peek() === "*" || peek() === "/")) {
      const op = text[pos++];
      const right = parseFactor();
      if (right === null) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };
  function parseSum(): number | null {
    let left = parseProduct();
    while (left !== null && (peek() === "+" || peek() === "-")) {
      const op = text[pos++];
      const right = parseProduct();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  const value = parseSum();
  return value !== null && pos === text.length && Number.isFinite(value) ? value : null;
}

/** Piecewise scrub sensitivity: pixels of pointer travel per unit of value at the given value. */
export function pixelsPerUnit(value: number, ranges: ReadonlyArray<{ upTo: number; pxPerUnit: number }>, fallback: number): number {
  for (const r of ranges) if (value <= r.upTo) return r.pxPerUnit;
  return fallback;
}
