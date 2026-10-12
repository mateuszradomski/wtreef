// Assertions are for programmer errors and contract violations: they crash
// loudly instead of letting a broken invariant spread through the view.

export class AssertionError extends Error {
  override name = "AssertionError";
}

/** In loops over every node, pass `message` as a function: it is then built only when the check fails. */
export function assert(condition: boolean, message: string | (() => string)): asserts condition {
  if (!condition) throw new AssertionError(typeof message === "string" ? message : message());
}

export function unreachable(value: never, message: string): never {
  throw new AssertionError(`${message}: ${String(value)}`);
}
