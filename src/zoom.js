export const MIN_ZOOM = 0.5, MAX_ZOOM = 3;
export const clampZoom = z => Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000)) : 1;
// Trackpad pinches send many small deltas; a mouse wheel with Ctrl sends ~100 per notch.
// Capping each event keeps one mouse notch at roughly ±20 %.
export function wheelZoomFactor(deltaY, deltaMode = 0) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-20, Math.min(20, px)) * 0.01);
}

// The page under a point of the scrolled content and where on it (as fractions of its size), as
// zooming keeps that spot under the pointer. pages: [{top, left, width, height}] in content
// coordinates, in order; the first page whose bottom is at or below y, else the last.
export function zoomAnchor(pages, x, y) {
  let i = pages.findIndex(p => p.top + p.height >= y);
  if (i < 0) i = pages.length - 1;
  const p = pages[i];
  return p ? {index: i, fx: (x - p.left) / p.width, fy: (y - p.top) / p.height} : null;
}

// One step of a pinch shown as a transform (scale s, then translate tx, ty) of the page column:
// scaling by k around the focal point (fx, fy) keeps that point where it is on screen.
export function pinchStep({s, tx, ty}, k, fx, fy) {
  return {s: s * k, tx: fx - k * (fx - tx), ty: fy - k * (fy - ty)};
}
