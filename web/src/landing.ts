// The landing page: one input that takes whatever people paste.

import { append, element, link } from "./dom.ts";
import { parsePullRequestInput, pullRequestPath } from "./route.ts";

/**
 * Real PRs with different shapes. Notes describe the shape, not the numbers:
 * open PRs keep changing, and hard-coded counts went stale within hours.
 */
const EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["l2beat/l2beat/pull/13157", "mostly additions"],
  ["denoland/deno/pull/36907", "mixed"],
  ["microsoft/vscode/pull/340789", "balanced add and delete"],
];

export function mountLanding(root: HTMLElement): void {
  document.title = "wtreef · see where a pull request lands";
  const column = element("main", "landing");
  const brand = element("h1", "landing-brand", "wtreef");
  const pitch = element("p", "landing-pitch", "See where a pull request changes a codebase: a treemap of the repository with the changed files lit up.");

  const form = element("form", "landing-form");
  form.noValidate = true;
  const label = element("label", "landing-label", "Paste a GitHub pull request URL");
  label.htmlFor = "pull-request-input";
  const input = element("input", "landing-input");
  input.id = "pull-request-input";
  input.type = "text";
  input.inputMode = "url";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "https://github.com/owner/repo/pull/123";
  const submit = element("button", "landing-submit", "View");
  submit.type = "submit";
  const error = element("p", "landing-error", "That doesn't look like a pull request. Try owner/repo/pull/123 or owner/repo#123.");
  error.hidden = true;
  error.id = "pull-request-input-error";
  input.setAttribute("aria-describedby", error.id);
  append(form, label, append(element("div", "landing-field"), input, submit), error);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const reference = parsePullRequestInput(input.value, window.location.host);
    error.hidden = reference !== null;
    input.setAttribute("aria-invalid", reference === null ? "true" : "false");
    if (reference !== null) window.location.assign(pullRequestPath(reference));
  });
  input.addEventListener("input", () => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  });

  const hint = append(
    element("p", "landing-hint"),
    "or replace ",
    element("span", "mono", "github.com"),
    " with ",
    element("span", "mono", window.location.host),
    " in any pull request URL",
  );
  const examples = element("ul", "landing-examples");
  for (const [path, description] of EXAMPLES) {
    const [owner, repo, , number] = path.split("/");
    const item = append(
      element("li", ""),
      link("landing-example mono", `/${path}`, `${owner}/${repo}#${number}`, false),
      element("span", "landing-example-note", description),
    );
    examples.append(item);
  }
  append(column, brand, pitch, form, hint, append(element("div", "landing-examples-block"), element("p", "landing-examples-title", "Examples"), examples));
  root.replaceChildren(column);
  input.focus();
}
