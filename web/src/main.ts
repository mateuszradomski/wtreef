// Entry point: route on the path, then hand the page to one of the views.

import { fetchPullRequestData } from "./api.ts";
import { assert } from "./assert.ts";
import { mountLanding } from "./landing.ts";
import { parseRoute, type PullRequestReference } from "./route.ts";
import { renderFailure, renderLoading, renderNotFoundPage } from "./states.ts";
import { mountPullRequestView } from "./view.ts";

function main(): void {
  const root = document.getElementById("app");
  assert(root !== null, "index.html must contain #app");
  const route = parseRoute(window.location.pathname);
  if (route.kind === "landing") {
    mountLanding(root);
  } else if (route.kind === "pullRequest") {
    void showPullRequest(root, route.reference);
  } else {
    renderNotFoundPage(root);
  }
}

async function showPullRequest(root: HTMLElement, reference: PullRequestReference): Promise<void> {
  renderLoading(root, reference);
  const result = await fetchPullRequestData(reference);
  if (result.kind === "loaded") {
    mountPullRequestView(root, result.data, window.location.search);
  } else {
    renderFailure(root, result, reference, () => void showPullRequest(root, reference));
  }
}

main();
