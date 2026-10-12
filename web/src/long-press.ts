// Touch has no right-click: holding a finger still for LONG_PRESS_MS opens
// the same menu. Moving more than LONG_PRESS_SLOP_PX, lifting, or the
// browser taking the gesture over for scrolling cancels it. Some browsers
// also fire contextmenu for a long press; whichever comes first claims the
// gesture, and the click that ends it is swallowed, so a long press never
// also opens a diff or zooms.

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;
const NO_TIMER = 0;

/** Where the press started, read when it starts: offsets are relative to the target as laid out then. */
export interface PressPoint {
  readonly target: EventTarget | null;
  readonly clientX: number;
  readonly clientY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface LongPress {
  timer: number;
  start: PressPoint;
  /** Set once the gesture opened a menu; its closing click is not a click. */
  claimed: boolean;
}

export function attachLongPress(target: HTMLElement, onLongPress: (point: PressPoint) => void): LongPress {
  const press: LongPress = {
    timer: NO_TIMER,
    start: { target: null, clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 },
    claimed: false,
  };
  target.addEventListener("pointerdown", (event) => {
    cancelTimer(press);
    press.claimed = false;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const { clientX, clientY, offsetX, offsetY } = event;
    press.start = { target: event.target, clientX, clientY, offsetX, offsetY };
    press.timer = window.setTimeout(() => {
      press.timer = NO_TIMER;
      press.claimed = true;
      onLongPress(press.start);
    }, LONG_PRESS_MS);
  });
  target.addEventListener("pointermove", (event) => {
    if (press.timer === NO_TIMER) return;
    const distance = Math.hypot(event.clientX - press.start.clientX, event.clientY - press.start.clientY);
    if (distance > LONG_PRESS_SLOP_PX) cancelTimer(press);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
    target.addEventListener(type, () => cancelTimer(press));
  }
  // After a touch, browsers send mouse events for old pages; their mousedown would pull focus out of the menu.
  target.addEventListener(
    "touchend",
    (event) => {
      if (press.claimed) event.preventDefault();
    },
    { passive: false },
  );
  return press;
}

function cancelTimer(press: LongPress): void {
  if (press.timer === NO_TIMER) return;
  window.clearTimeout(press.timer);
  press.timer = NO_TIMER;
}

/** For a contextmenu event: true when a long press already opened the menu. Otherwise a pending press is claimed by it. */
export function longPressOpenedMenu(press: LongPress): boolean {
  if (press.claimed) return true;
  if (press.timer !== NO_TIMER) {
    cancelTimer(press);
    press.claimed = true;
  }
  return false;
}

/** For a click: true when it ends a long press and must be ignored. */
export function isLongPressClick(press: LongPress): boolean {
  if (!press.claimed) return false;
  press.claimed = false;
  return true;
}
