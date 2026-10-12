import { fetchPullRequestData } from "./api.ts";
import { assert } from "./assert.ts";
import { parseRoute, type PullRequestReference } from "./route.ts";
import { mountPullRequestView } from "./view.ts";

function main(): void {
  const root = document.getElementById("app");
  assert(root !== null, "index.html must contain #app");
  const route = parseRoute(window.location.pathname);
  if (route.kind === "pullRequest") {
    void showPullRequest(root, route.reference);
  } else {
    root.textContent = route.kind === "landing" ? "wtreef" : "Not found";
  }
}

async function showPullRequest(root: HTMLElement, reference: PullRequestReference): Promise<void> {
  root.textContent = `Fetching ${reference.owner}/${reference.repo}#${reference.number} from GitHub…`;
  const result = await fetchPullRequestData(reference);
  if (result.kind === "loaded") {
    mountPullRequestView(root, result.data);
  } else {
    root.textContent = `Could not load: ${result.kind}`;
  }
}

main();
