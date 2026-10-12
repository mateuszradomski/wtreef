// Path grammar from docs/wire-format.md ("Path parsing"). The decoder reuses
// these so the page route and the API payload agree on what a name is.

export interface PullRequestReference {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export type Route =
  | { readonly kind: "landing" }
  | { readonly kind: "pullRequest"; readonly reference: PullRequestReference }
  | { readonly kind: "notFound" };

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PULL_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
const PULL_NUMBER_MAX = 2147483647;
const PATH_SEGMENTS_MAX = 64;

export function isOwnerName(text: string): boolean {
  return OWNER_PATTERN.test(text);
}

export function isRepoName(text: string): boolean {
  if (text === "." || text === "..") return false;
  return REPO_PATTERN.test(text);
}

export function isPullNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= PULL_NUMBER_MAX;
}

/** Returns the pull request number, or null when the text is not one. */
export function parsePullNumber(text: string): number | null {
  if (!PULL_NUMBER_PATTERN.test(text)) return null;
  const value = Number(text);
  if (!isPullNumber(value)) return null;
  return value;
}

export function pullRequestPath(reference: PullRequestReference): string {
  return `/${reference.owner}/${reference.repo}/pull/${reference.number}`;
}

/** Parses `owner/repo/pull/n[/anything]` segments, as used by both page routes and pasted URLs. */
function parseSegments(segments: readonly string[]): PullRequestReference | null {
  if (segments.length < 4) return null;
  if (segments.length > PATH_SEGMENTS_MAX) return null;
  const [owner, repo, pull, numberText] = segments;
  if (owner === undefined || repo === undefined || numberText === undefined) return null;
  if (pull !== "pull") return null;
  if (!isOwnerName(owner)) return null;
  if (!isRepoName(repo)) return null;
  const number = parsePullNumber(numberText);
  if (number === null) return null;
  return { owner, repo, number };
}

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { kind: "landing" };
  const segments = pathname.split("/").slice(1);
  const reference = parseSegments(segments);
  if (reference === null) return { kind: "notFound" };
  return { kind: "pullRequest", reference };
}

const SHORT_FORM_PATTERN = /^([^/#?\s]+)\/([^/#?\s]+)#([0-9]+)$/;
const SCHEME_PREFIX_PATTERN = /^(?:https?:\/\/)?(?:www\.)?/i;
const KNOWN_HOSTS = ["github.com", "wtreef.com"];

/**
 * Accepts what people paste: `https://github.com/o/r/pull/n[/...]`, the same
 * on wtreef.com or `ownHost` (where this page is served), `o/r/pull/n`, and
 * `o/r#n`. Returns null for anything else.
 */
export function parsePullRequestInput(input: string, ownHost = ""): PullRequestReference | null {
  const text = input.trim();
  const shortForm = SHORT_FORM_PATTERN.exec(text);
  if (shortForm !== null) {
    const [, owner, repo, numberText] = shortForm;
    if (owner === undefined || repo === undefined || numberText === undefined) return null;
    return parseSegments([owner, repo, "pull", numberText]);
  }
  const withoutScheme = text.replace(SCHEME_PREFIX_PATTERN, "");
  const lowered = withoutScheme.toLowerCase();
  const host = [...KNOWN_HOSTS, ownHost.toLowerCase()].find((name) => name !== "" && lowered.startsWith(`${name}/`));
  const withoutHost = host === undefined ? text : withoutScheme.slice(host.length + 1);
  const pathOnly = withoutHost.split(/[?#]/, 1)[0] ?? "";
  return parseSegments(pathOnly.split("/"));
}
