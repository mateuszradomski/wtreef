// Shared helpers for `node --test`. Never imported by the app bundle.

import { readFileSync } from "node:fs";

export const TINY_FIXTURE = "wtreef-example-1.json";
export const REAL_FIXTURE = "l2beat-l2beat-13157.json";

/** Returns a fresh parsed copy of a fixture, so tests can mutate it freely. */
export function loadFixtureJson(name: string): Record<string, unknown> {
  const text = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}
