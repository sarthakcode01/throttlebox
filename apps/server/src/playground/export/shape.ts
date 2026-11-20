/**
 * Describe the structure of a JSON value without its data.
 *
 * Objects keep their keys, arrays are described by their first element, and
 * leaves become a type name. Two responses with the same shape but different
 * values (e.g. a different generated name) therefore produce the same shape.
 */
export type Shape = string | Shape[] | { [key: string]: Shape };

export function inferShape(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [inferShape(value[0])];
  if (typeof value === 'object') {
    const out: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = inferShape((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}
