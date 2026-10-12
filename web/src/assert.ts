// Assertions are for programmer errors and contract violations: they crash
// loudly instead of letting a broken invariant spread through the view.

export class AssertionError extends Error {
  override name = "AssertionError";
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function unreachable(value: never, message: string): never {
  throw new AssertionError(`${message}: ${String(value)}`);
}
