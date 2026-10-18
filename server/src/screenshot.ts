import { z } from "zod";

export const MAX_SCREENSHOT_BYTES = 384 * 1024;
export const MAX_SCREENSHOT_EDGE = 1280;
const maxBase64 = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);

/** Validate framing and encoded dimensions without decoding or writing pixels to disk. */
function jpegDimensions(data: string): { width: number; height: number } | undefined {
  if (!data.length || data.length > maxBase64 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_SCREENSHOT_BYTES || bytes.toString("base64") !== data || bytes.length < 16 ||
      bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  let cursor = 2;
  let dimensions: { width: number; height: number } | undefined;
  while (cursor + 3 < bytes.length) {
    if (bytes[cursor++] !== 0xff) return;
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xd9 || marker === 0xd8 || marker === 0x00 || marker === undefined) return;
    if (cursor + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length - 2) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 8 || bytes[cursor + 2] !== 8) return;
      const height = bytes.readUInt16BE(cursor + 3), width = bytes.readUInt16BE(cursor + 5);
      if (!height || !width || height > MAX_SCREENSHOT_EDGE || width > MAX_SCREENSHOT_EDGE) return;
      dimensions = { width, height };
    }
    // Entropy data is opaque. A real image decoder remains the provider's responsibility.
    if (marker === 0xda) return dimensions;
    cursor += length;
  }
}

const screenshotFields = {
  kind: z.literal("screenshot"), captureId: z.string().min(1).max(128),
  packageName: z.string().min(1).max(512), windowId: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(MAX_SCREENSHOT_EDGE), height: z.number().int().min(1).max(MAX_SCREENSHOT_EDGE),
  mimeType: z.literal("image/jpeg"), source: z.enum(["window", "display"]),
};
const observationMetadataSchema = z.object({ ...screenshotFields, observationOnly: z.literal(true) }).strict();
const visualMetadataSchema = z.object({ ...screenshotFields, observationOnly: z.literal(false),
  actionContract: z.literal("visual-tap-v1"), expiresInMs: z.literal(60_000),
  supportedActions: z.array(z.enum(["tap_visual", "swipe_visual"])).min(1).max(2)
    .refine(actions => new Set(actions).size === actions.length && actions.includes("tap_visual")).optional(),
}).strict();
export const ScreenshotMetadataSchema = z.discriminatedUnion("observationOnly", [observationMetadataSchema, visualMetadataSchema]);
export type ScreenshotMetadata = z.infer<typeof ScreenshotMetadataSchema>;
export const ScreenshotImageSchema = z.object({
  mimeType: z.literal("image/jpeg"), data: z.string().max(maxBase64).refine(data => jpegDimensions(data) !== undefined, "Invalid bounded JPEG image"),
}).strict();
export const PhoneScreenshotSchema = z.discriminatedUnion("observationOnly", [
  observationMetadataSchema.extend({ data: ScreenshotImageSchema.shape.data }),
  visualMetadataSchema.extend({ data: ScreenshotImageSchema.shape.data }),
])
  .refine(value => {
    const dimensions = jpegDimensions(value.data);
    return dimensions?.width === value.width && dimensions.height === value.height;
  }, "Screenshot dimensions do not match JPEG");

/** Read only allowlisted metadata. Pixels remain an ephemeral separate channel. */
export function screenshotMetadata(value: unknown): ScreenshotMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const keys = [...Object.keys(screenshotFields), "observationOnly",
    ...(source.observationOnly === false ? ["actionContract", "expiresInMs", ...(source.supportedActions !== undefined ? ["supportedActions"] : [])] : [])];
  const parsed = ScreenshotMetadataSchema.safeParse(Object.fromEntries(keys.map(key => [key, source[key]])));
  return parsed.success ? parsed.data : undefined;
}
