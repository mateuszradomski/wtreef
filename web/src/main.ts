// Entry point: the server says which app this is. The website routes on the
// path to the landing page or a pull request; the local server only ever
// serves its one branch, at "/".

import { fetchBranchData, fetchPullRequestData, watchPullRequestProgress } from "./api.ts";
import { assert } from "./assert.ts";
import { mountLanding } from "./landing.ts";
import { parseRoute, type PullRequestReference } from "./route.ts";
import { renderBranchFailure, renderBranchLoading, renderFailure, renderLoading, renderNotFoundPage } from "./states.ts";
import { mountTreemapView } from "./view.ts";

type Mode = "web" | "local";

/** index.html carries `<meta name="wtreef-mode">`, filled in by the server. */
function readMode(): Mode {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="wtreef-mode"]');
  return meta?.content === "local" ? "local" : "web";
}

function main(): void {
  const root = document.getElementById("app");
  assert(root !== null, "index.html must contain #app");
  if (readMode() === "local") {
    void showBranch(root);
    return;
  }
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
  const showProgress = renderLoading(root, reference);
  const stopWatching = watchPullRequestProgress(reference, showProgress);
  const result = await fetchPullRequestData(reference);
  stopWatching();
  if (result.kind === "loaded") {
    mountTreemapView(root, result.data, window.location.search);
  } else {
    renderFailure(root, result, reference, () => void showPullRequest(root, reference));
  }
}

async function showBranch(root: HTMLElement): Promise<void> {
  renderBranchLoading(root);
  const result = await fetchBranchData();
  if (result.kind === "loaded") {
    mountTreemapView(root, result.data, window.location.search);
  } else {
    renderBranchFailure(root, result, () => void showBranch(root));
  }
}

main();
