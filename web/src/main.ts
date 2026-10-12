import { assert } from "./assert.ts";

function main(): void {
  const root = document.getElementById("app");
  assert(root !== null, "index.html must contain #app");
  root.textContent = "wtreef";
}

main();
