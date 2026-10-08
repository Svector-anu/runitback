/** A unit-length copy of `vector`; the zero vector stays zero. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (length === 0) return out;
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] ?? 0) / length;
  return out;
}

/** Dot product of `a` with the `a.length` floats of `matrix` starting at `offset`. */
export function dotAt(a: Float32Array, matrix: Float32Array, offset: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (matrix[offset + i] ?? 0);
  return sum;
}
