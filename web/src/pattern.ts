// Path patterns behind the Include and Exclude filters. Parse, don't
// validate: typed text becomes nothing, a compiled RegExp, or the reason it
// is not one. The rest of the client never re-checks raw pattern text.

import { assert } from "./assert.ts";

/** Longer text is rejected rather than compiled: no one types it, and it only arrives through edited links. */
export const PATH_PATTERN_LENGTH_MAX = 200;
/**
 * Case-insensitive and nothing else. "g" and "y" make RegExp.test stateful
 * through lastIndex, so one path could match on one call and miss the next.
 */
const PATH_PATTERN_FLAGS = "i";

export type PathPattern =
  | { readonly kind: "empty" }
  | { readonly kind: "valid"; readonly source: string; readonly regex: RegExp }
  | { readonly kind: "invalid"; readonly source: string; readonly message: string };

export const EMPTY_PATH_PATTERN: PathPattern = { kind: "empty" };

export function parsePathPattern(text: string): PathPattern {
  if (text === "") return EMPTY_PATH_PATTERN;
  if (text.length > PATH_PATTERN_LENGTH_MAX) {
    return { kind: "invalid", source: text, message: `Longer than ${PATH_PATTERN_LENGTH_MAX} characters` };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(text, PATH_PATTERN_FLAGS);
  } catch (error) {
    assert(error instanceof SyntaxError, "the RegExp constructor only throws SyntaxError");
    return { kind: "invalid", source: text, message: describeSyntaxError(error.message) };
  }
  assertStateless(regex);
  return { kind: "valid", source: text, regex };
}

/** The text the pattern came from; "" when empty. */
export function patternSource(pattern: PathPattern): string {
  return pattern.kind === "empty" ? "" : pattern.source;
}

/** The regex to filter with, or null: an empty pattern filters nothing and an invalid one is ignored. */
export function activeRegex(pattern: PathPattern): RegExp | null {
  if (pattern.kind !== "valid") return null;
  assertStateless(pattern.regex);
  return pattern.regex;
}

function assertStateless(regex: RegExp): void {
  assert(!regex.global, "a global regex carries lastIndex between tests");
  assert(!regex.sticky, "a sticky regex carries lastIndex between tests");
  assert(regex.ignoreCase, "path patterns are case-insensitive");
}

/**
 * Engines prefix the reason with the whole pattern ("Invalid regular
 * expression: /(/i: Unterminated group"). The pattern is already on screen
 * in the input, so only the reason after the last ": " is worth showing.
 */
export function describeSyntaxError(message: string): string {
  const separator = message.lastIndexOf(": ");
  const reason = (separator < 0 ? message : message.slice(separator + 2)).trim();
  if (reason === "") return "Not a valid regular expression";
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}
