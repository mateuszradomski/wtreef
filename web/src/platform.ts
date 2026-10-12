// Which modifier key to name in hints: Option (⌥) on Apple platforms, Alt
// elsewhere. Client hints name the platform where browsers support them;
// navigator.platform, deprecated but everywhere, is the fallback.

import { assert } from "./assert.ts";

const APPLE_PLATFORM_PATTERN = /^(mac|iphone|ipad|ipod|ios)/i;

/** True for "macOS", "MacIntel", "iPhone", "iPad"; iPadOS reports itself as "MacIntel". */
export function isApplePlatform(platform: string): boolean {
  return APPLE_PLATFORM_PATTERN.test(platform.trim());
}

/** "⌥" on Apple platforms, "Alt" elsewhere, as the keys are printed. */
export function altKeyLabel(platform: string): string {
  return isApplePlatform(platform) ? "⌥" : "Alt";
}

/** Not in the DOM types yet: Chromium's User-Agent Client Hints. */
interface NavigatorWithClientHints {
  readonly userAgentData?: { readonly platform?: string };
}

export function currentPlatform(): string {
  const hinted = (navigator as Navigator & NavigatorWithClientHints).userAgentData?.platform ?? "";
  const platform = hinted !== "" ? hinted : navigator.platform;
  assert(typeof platform === "string", "browsers name a platform, if only as an empty string");
  return platform;
}
