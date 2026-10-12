// Methodology: feed the platform names browsers report through client hints
// and through navigator.platform, and check which get the Option key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { altKeyLabel, isApplePlatform } from "./platform.ts";

test("Apple platforms name the Option key, by either source", () => {
  for (const platform of ["macOS", "MacIntel", "MacPPC", "iPhone", "iPad", "iPod touch", "iOS"]) {
    assert.ok(isApplePlatform(platform), platform);
    assert.equal(altKeyLabel(platform), "⌥");
  }
});

test("everything else names Alt, including an unknown or empty platform", () => {
  for (const platform of ["Windows", "Win32", "Linux", "Linux x86_64", "Android", "Chrome OS", "", "Unknown"]) {
    assert.equal(isApplePlatform(platform), false, platform);
    assert.equal(altKeyLabel(platform), "Alt");
  }
});
