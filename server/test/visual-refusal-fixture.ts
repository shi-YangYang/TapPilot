import type { VisualComparison } from "../src/diagnostics/schema.js";

// Synthetic aggregate evidence, never sampled from a real screenshot.
export const visualComparison = (): VisualComparison => ({
  triggers: ["global_fraction", "local_pixels"], referenceAgeMs: 60_123,
  globalPixelCount: 1024, globalChangedPixels: 8, globalMeanRgbMilli: 400,
  localPixelCount: 25, localChangedPixels: 2, localMeanRgbMilli: 600,
});
export const visualDetails = () => ({ executor: "visual-tap-v1" as const, dispatchState: "not_sent" as const,
  visualComparison: visualComparison() });
export const visualError = () => ({ code: "VISUAL_SCENE_CHANGED", message: "Synthetic scene difference", retryable: false,
  details: visualDetails() });
