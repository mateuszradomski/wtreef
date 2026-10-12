// The network calls: a pull request on the website, the branch locally.
// Every outcome becomes a tagged result, so the view can render a specific
// state for each and never sees a raw exception.

import { type ApiError, decodeApiError, decodeBranchData, decodePullRequestData, type TreemapData } from "./decode.ts";
import type { PullRequestReference } from "./route.ts";

export type FetchResult =
  | { readonly kind: "loaded"; readonly data: TreemapData }
  | { readonly kind: "apiError"; readonly error: ApiError }
  | { readonly kind: "unreachable" }
  | { readonly kind: "invalidResponse"; readonly httpStatus: number };

function apiPath(reference: PullRequestReference): string {
  const owner = encodeURIComponent(reference.owner);
  const repo = encodeURIComponent(reference.repo);
  return `/api/pr/${owner}/${repo}/${reference.number}`;
}

export function fetchPullRequestData(reference: PullRequestReference): Promise<FetchResult> {
  return fetchTreemapData(apiPath(reference), "default", decodePullRequestData);
}

/** The working tree changes under the page, so the answer is never cached. */
export function fetchBranchData(): Promise<FetchResult> {
  return fetchTreemapData("/api/local", "no-store", decodeBranchData);
}

async function fetchTreemapData(path: string, cache: RequestCache, decode: (json: unknown) => TreemapData): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache,
      redirect: "follow",
    });
  } catch {
    return { kind: "unreachable" };
  }
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    return { kind: "invalidResponse", httpStatus: response.status };
  }
  try {
    if (response.ok) return { kind: "loaded", data: decode(json) };
    const error = decodeApiError(response.status, json, response.headers.get("Retry-After"), Date.now());
    return { kind: "apiError", error };
  } catch (error) {
    // A contract violation is a server bug: surface it for whoever is debugging, show a calm message to everyone else.
    console.error("wtreef: response violates docs/wire-format.md", error);
    return { kind: "invalidResponse", httpStatus: response.status };
  }
}
