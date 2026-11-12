/**
 * Tiny animation helpers. All motion is defined in styles.css; these only toggle classes so
 * the same animation can be replayed, and they respect "reduce motion" system settings.
 */

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** (Re)play a one-shot CSS animation class on an element. */
export function flash(el: HTMLElement | null | undefined, cls: string): void {
  if (!el) return;
  el.removeClass(cls);
  // Force a reflow so removing and re-adding the class restarts the animation.
  void el.offsetWidth;
  el.addClass(cls);
  const done = () => el.removeClass(cls);
  el.addEventListener("animationend", done, { once: true });
  // Fallback when no animation runs (reduced motion, element hidden…).
  window.setTimeout(done, 1000);
}

/**
 * Play an exit animation and resolve when it ends (or after `maxMs` as a fallback).
 * The class is left on the element; callers usually remove or rebuild it afterwards.
 */
export function animateOut(el: HTMLElement | null | undefined, cls: string, maxMs = 220): Promise<void> {
  if (!el || prefersReducedMotion() || !el.isShown()) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    el.addEventListener("animationend", finish, { once: true });
    window.setTimeout(finish, maxMs);
    el.addClass(cls);
  });
}
