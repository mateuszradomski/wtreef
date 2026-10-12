// Full-page states around the treemap: loading, every error the contract
// defines, and pages that do not exist. Copy is written for the person who
// pasted a link, not for whoever runs the server.

import { unreachable } from "./assert.ts";
import type { FetchResult } from "./api.ts";
import type { ApiError } from "./decode.ts";
import { append, button, element, link } from "./dom.ts";
import { formatWait } from "./format.ts";
import type { PullRequestReference } from "./route.ts";

/** A retry countdown never runs longer than this, whatever Retry-After says. */
const RETRY_COUNTDOWN_SECONDS_MAX = 6 * 60 * 60;

function referenceLabel(reference: PullRequestReference): string {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

function githubUrl(reference: PullRequestReference): string {
  return `https://github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pull/${reference.number}`;
}

function statePage(title: string, ...body: HTMLElement[]): HTMLElement {
  const page = element("main", "state-page");
  const brand = link("brand state-brand", "/", "wtreef", false);
  const heading = element("h1", "state-title", title);
  return append(page, brand, heading, ...body);
}

export function renderLoading(root: HTMLElement, reference: PullRequestReference): void {
  document.title = `${referenceLabel(reference)} · wtreef`;
  const progress = element("div", "loading-bar");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Loading");
  progress.append(element("span", "loading-bar-fill"));
  const page = statePage(
    `Fetching ${referenceLabel(reference)} from GitHub…`,
    progress,
    element("p", "state-detail", "The first visit to a large repository can take a few seconds."),
  );
  page.setAttribute("aria-busy", "true");
  root.replaceChildren(page);
}

export function renderBranchLoading(root: HTMLElement): void {
  document.title = "wtreef";
  const progress = element("div", "loading-bar");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Loading");
  progress.append(element("span", "loading-bar-fill"));
  const page = statePage("Reading your branch…", progress);
  page.setAttribute("aria-busy", "true");
  root.replaceChildren(page);
}

export function renderNotFoundPage(root: HTMLElement): void {
  document.title = "Not found · wtreef";
  const detail = element(
    "p",
    "state-detail",
    "wtreef pages look like a GitHub pull request URL with the host swapped: /owner/repo/pull/123.",
  );
  root.replaceChildren(statePage("This page doesn't exist", detail, actions(link("text-button", "/", "Go to wtreef", false))));
}

function actions(...children: HTMLElement[]): HTMLElement {
  return append(element("div", "state-actions"), ...children);
}

interface ErrorCopy {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
}

export type FetchFailure = Exclude<FetchResult, { readonly kind: "loaded" }>;

/** `label` names what failed to load, e.g. "owner/repo#123". */
export function describeFailure(result: FetchFailure, label: string): ErrorCopy {
  if (result.kind === "apiError") return describeApiError(result.error, label);
  if (result.kind === "unreachable") {
    return { title: "Couldn't reach wtreef", detail: "Check your connection, then try again.", retryable: true, retryAfterSeconds: null };
  }
  return {
    title: "Something went wrong on our side",
    detail: `The server answered with something this page doesn't understand (HTTP ${result.httpStatus}). Trying again may help.`,
    retryable: true,
    retryAfterSeconds: null,
  };
}

function describeApiError(error: ApiError, label: string): ErrorCopy {
  const wait = error.retryAfterSeconds;
  switch (error.code) {
    case "not_found":
      return {
        title: `Couldn't find ${label}`,
        detail:
          "Check the owner, repository and number. Private repositories also show up as not found: wtreef can only read public code.",
        retryable: false,
        retryAfterSeconds: null,
      };
    case "bad_request":
      return {
        title: "That isn't a pull request URL",
        detail: "wtreef pages look like a GitHub pull request URL with the host swapped: /owner/repo/pull/123.",
        retryable: false,
        retryAfterSeconds: null,
      };
    case "too_many_requests":
      return {
        title: "Too many requests",
        detail: "You've opened a lot of pull requests in a short time. Requests are limited per visitor so everyone gets a share of GitHub's budget.",
        retryable: true,
        retryAfterSeconds: wait,
      };
    case "github_rate_limited":
      return {
        title: "wtreef is out of GitHub requests",
        detail: `The server has used up its GitHub API budget for now. ${wait === null ? "It refills within the hour" : `It refills in about ${formatWait(wait)}`}.`,
        retryable: true,
        retryAfterSeconds: wait,
      };
    case "upstream_error":
      return {
        title: "GitHub had a problem",
        detail: "GitHub returned an error or something unexpected. This is usually temporary.",
        retryable: true,
        retryAfterSeconds: null,
      };
    case "local_error":
      // Only the local server sends this, and its message is git's own, for the person who ran it.
      return { title: "Couldn't read the repository", detail: error.message, retryable: true, retryAfterSeconds: null };
    default:
      return unreachable(error.code, "unknown API error code");
  }
}

/** The local server has no pull request to link to; the terminal running it is the place to look. */
export function renderBranchFailure(root: HTMLElement, result: FetchFailure, onRetry: () => void): void {
  const copy: ErrorCopy =
    result.kind === "unreachable"
      ? { title: "Couldn't reach wtreef", detail: "Is wtreef still running in your terminal? Start it again, then try again.", retryable: true, retryAfterSeconds: null }
      : describeFailure(result, "the branch");
  document.title = `${copy.title} · wtreef`;
  const detail = element("p", "state-detail", copy.detail);
  const page = statePage(copy.title, detail, actions(createRetryButton(copy.retryAfterSeconds, onRetry)));
  page.setAttribute("role", "alert");
  root.replaceChildren(page);
}

/** Renders the failure and, when retrying can help, a Retry button that counts down Retry-After first. */
export function renderFailure(root: HTMLElement, result: FetchFailure, reference: PullRequestReference, onRetry: () => void): void {
  const copy = describeFailure(result, referenceLabel(reference));
  document.title = `${copy.title} · wtreef`;
  const buttons: HTMLElement[] = [];
  if (copy.retryable) buttons.push(createRetryButton(copy.retryAfterSeconds, onRetry));
  buttons.push(link("text-button", githubUrl(reference), "Open on GitHub ↗", true));
  buttons.push(link("text-button", "/", "Go to wtreef", false));
  const detail = element("p", "state-detail", copy.detail);
  const page = statePage(copy.title, detail, actions(...buttons));
  page.setAttribute("role", "alert");
  root.replaceChildren(page);
}

function createRetryButton(retryAfterSeconds: number | null, onRetry: () => void): HTMLButtonElement {
  const retry = button("state-retry", "Try again");
  retry.addEventListener("click", onRetry);
  if (retryAfterSeconds === null || retryAfterSeconds <= 0) return retry;
  let remaining = Math.min(Math.ceil(retryAfterSeconds), RETRY_COUNTDOWN_SECONDS_MAX);
  retry.disabled = true;
  retry.textContent = `Try again in ${formatWait(remaining)}`;
  const timer = window.setInterval(() => {
    remaining -= 1;
    if (!retry.isConnected) {
      window.clearInterval(timer);
    } else if (remaining > 0) {
      retry.textContent = `Try again in ${formatWait(remaining)}`;
    } else {
      window.clearInterval(timer);
      retry.disabled = false;
      retry.textContent = "Try again";
    }
  }, 1000);
  return retry;
}
