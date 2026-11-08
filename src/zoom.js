export const MIN_ZOOM = 0.5, MAX_ZOOM = 3;
export const clampZoom = z => Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000)) : 1;
// Trackpad pinches send many small deltas; a mouse wheel with Ctrl sends ~100 per notch.
// Capping each event keeps one mouse notch at roughly ±20 %.
export function wheelZoomFactor(deltaY, deltaMode = 0) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-20, Math.min(20, px)) * 0.01);
}
