/**
 * FORGE TQ-039 Visual regression engine.
 *
 * Market laws (Pixelmatch, Percy, Applitools):
 * - Diffs are computed per pixel with perceptual luminance weighting:
 *   a pixel differs when 0.299*|dr| + 0.587*|dg| + 0.114*|db| exceeds
 *   the threshold scaled to 255 (default threshold 0.1).
 * - Ignore regions mask rectangles of pixels: masked pixels are
 *   excluded from both the difference count and the denominator.
 * - diffPercent is the share of DIFFERING pixels among COMPARABLE
 *   pixels (total minus ignored), rounded to two decimals.
 * - Images are grids of lowercase-normalizable #rrggbb hex pixels.
 *
 * Pure engine: no framework imports, no I/O, fully deterministic.
 */

export const VISUAL_PIXEL_RE = /^#[0-9a-f]{6}$/i;
export const VISUAL_THRESHOLD_DEFAULT = 0.1;

export interface VisualDiffInput {
  baseline?: unknown;
  candidate?: unknown;
  threshold?: unknown;
  ignoreRegions?: unknown;
}

export interface VisualDiffResult {
  ok: boolean;
  reason?: string;
  width?: number;
  height?: number;
  total?: number;
  ignored?: number;
  different?: number;
  diffPercent?: number;
  identical?: boolean;
}

interface ValidatedImage {
  width: number;
  height: number;
  pixels: string[];
}

function parseChannel(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

function validateImage(image: unknown, label: string): { ok: boolean; reason?: string; image?: ValidatedImage } {
  if (typeof image !== 'object' || image === null) {
    return { ok: false, reason: 'visual-image-missing:' + label };
  }
  const record = image as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  const pixels = record.pixels;
  if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0) {
    return { ok: false, reason: 'visual-dimension-invalid:' + label + ':width' };
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height <= 0) {
    return { ok: false, reason: 'visual-dimension-invalid:' + label + ':height' };
  }
  if (!Array.isArray(pixels) || pixels.length !== width * height) {
    return { ok: false, reason: 'visual-pixels-invalid:' + label };
  }
  for (let i = 0; i < pixels.length; i++) {
    if (typeof pixels[i] !== 'string' || !VISUAL_PIXEL_RE.test(pixels[i])) {
      return { ok: false, reason: 'visual-pixel-invalid:' + label + ':' + (i + 1) };
    }
  }
  return { ok: true, image: { width, height, pixels: pixels as string[] } };
}

function regionInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function diffImages(input: VisualDiffInput): VisualDiffResult {
  const baseline = validateImage(input?.baseline, 'baseline');
  if (!baseline.ok) return { ok: false, reason: baseline.reason };
  const candidate = validateImage(input?.candidate, 'candidate');
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  const base = baseline.image as ValidatedImage;
  const cand = candidate.image as ValidatedImage;
  if (base.width !== cand.width || base.height !== cand.height) {
    return {
      ok: false,
      reason: 'visual-size-mismatch:' + base.width + 'x' + base.height + ':' + cand.width + 'x' + cand.height,
    };
  }
  const rawThreshold: unknown = input?.threshold;
  const threshold = rawThreshold === undefined ? VISUAL_THRESHOLD_DEFAULT : rawThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { ok: false, reason: 'visual-threshold-invalid:' + String(threshold) };
  }
  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
  if (input?.ignoreRegions !== undefined) {
    const rawRegions = input.ignoreRegions;
    if (!Array.isArray(rawRegions)) return { ok: false, reason: 'visual-regions-invalid' };
    for (let i = 0; i < rawRegions.length; i++) {
      const region = rawRegions[i] as Record<string, unknown>;
      if (
        typeof region !== 'object' ||
        region === null ||
        !regionInt(region.x) ||
        !regionInt(region.y) ||
        !regionInt(region.width) ||
        !regionInt(region.height) ||
        (region.width as number) <= 0 ||
        (region.height as number) <= 0 ||
        (region.x as number) + (region.width as number) > base.width ||
        (region.y as number) + (region.height as number) > base.height
      ) {
        return { ok: false, reason: 'visual-region-invalid:' + (i + 1) };
      }
      regions.push({ x: region.x as number, y: region.y as number, width: region.width as number, height: region.height as number });
    }
  }
  const limit = threshold * 255;
  let different = 0;
  let ignored = 0;
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const index = y * base.width + x;
      const masked = regions.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
      if (masked) {
        ignored++;
        continue;
      }
      const a = base.pixels[index]!;
      const b = cand.pixels[index]!;
      if (a === b) continue;
      const dr = Math.abs(parseChannel(a, 1) - parseChannel(b, 1));
      const dg = Math.abs(parseChannel(a, 3) - parseChannel(b, 3));
      const db = Math.abs(parseChannel(a, 5) - parseChannel(b, 5));
      if (0.299 * dr + 0.587 * dg + 0.114 * db > limit) different++;
    }
  }
  const total = base.width * base.height;
  const comparable = total - ignored;
  const diffPercent = comparable === 0 ? 0 : Number(((different / comparable) * 100).toFixed(2));
  return {
    ok: true,
    width: base.width,
    height: base.height,
    total,
    ignored,
    different,
    diffPercent,
    identical: different === 0,
  };
}
