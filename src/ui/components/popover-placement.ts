/**
 * Placement of an upward-opening popover (pure, unit-tested).
 * Coordinates are viewport pixels; the result is relative to the boundary element,
 * which the popover is absolutely positioned in.
 */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Placement {
  /** px from the boundary's left edge */
  left: number;
  /** px from the boundary's bottom edge (the popover grows upwards from here) */
  bottom: number;
  width: number;
  maxHeight: number;
}

export interface PlacementOptions {
  gap?: number;
  margin?: number;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export function placeAbove(anchor: RectLike, boundary: RectLike, opts: PlacementOptions = {}): Placement {
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const available = Math.max(0, boundary.width - margin * 2);
  const width = Math.min(Math.max(anchor.width, opts.minWidth ?? 240), opts.maxWidth ?? 360, available);

  // Left-align with the anchor, but keep the popover inside the boundary.
  let left = anchor.left - boundary.left;
  left = Math.min(left, boundary.width - margin - width);
  left = Math.max(left, margin);

  const bottom = boundary.bottom - anchor.top + gap;
  const room = anchor.top - boundary.top - gap - margin;
  const maxHeight = Math.max(80, Math.min(opts.maxHeight ?? 360, room));
  return { left: Math.round(left), bottom: Math.round(bottom), width: Math.round(width), maxHeight: Math.round(maxHeight) };
}
