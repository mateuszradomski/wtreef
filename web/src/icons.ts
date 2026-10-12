// Inline SVG icons, stroked in currentColor so they take the color of the
// text around them. Each is built once and cloned: a re-render of 2,000
// tree rows clones 2,000 of them. Presentation attributes, not style
// attributes, so the CSP allows them.

import { assert } from "./assert.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ICON_SIZE_PX = 16;

export const IconKind = { hide: "hide", show: "show" } as const;
export type IconKind = (typeof IconKind)[keyof typeof IconKind];

/** An eye drawn on a 16px grid: the outline, the pupil, and for "hide" a slash across both. */
const EYE_OUTLINE = "M1.75 8C3.1 5.4 5.3 3.75 8 3.75S12.9 5.4 14.25 8C12.9 10.6 10.7 12.25 8 12.25S3.1 10.6 1.75 8Z";
const SLASH = "M3 13 13 3";

const templates = new Map<IconKind, SVGSVGElement>();

export function createIcon(kind: IconKind): SVGSVGElement {
  let template = templates.get(kind);
  if (template === undefined) {
    template = buildIcon(kind);
    templates.set(kind, template);
  }
  const icon = template.cloneNode(true);
  assert(icon instanceof SVGSVGElement, "a clone of an svg is an svg");
  return icon;
}

function buildIcon(kind: IconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  const attributes: ReadonlyArray<readonly [string, string]> = [
    ["viewBox", `0 0 ${ICON_SIZE_PX} ${ICON_SIZE_PX}`],
    ["width", String(ICON_SIZE_PX)],
    ["height", String(ICON_SIZE_PX)],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "1.25"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    // Decorative: the control around the icon carries the name.
    ["aria-hidden", "true"],
    ["focusable", "false"],
  ];
  for (const [name, value] of attributes) svg.setAttribute(name, value);
  svg.append(svgElement("path", [["d", EYE_OUTLINE]]), svgElement("circle", [["cx", "8"], ["cy", "8"], ["r", "2"]]));
  if (kind === IconKind.hide) svg.append(svgElement("path", [["d", SLASH]]));
  return svg;
}

function svgElement(tag: "path" | "circle", attributes: ReadonlyArray<readonly [string, string]>): SVGElement {
  const created = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of attributes) created.setAttribute(name, value);
  return created;
}
