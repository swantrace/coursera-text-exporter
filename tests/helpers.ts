import assert from "node:assert/strict";
export function required<T>(value: T | null | undefined): T {
  assert.ok(
    value !== null && value !== undefined,
    "Expected a fixture value to exist",
  );
  return value;
}
