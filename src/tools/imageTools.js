// Image analysis — gives a text-only model real, grounded information
// about an image instead of letting it guess or hallucinate a
// description. The backend model (Qwen/Gemma-class, see identityFilter.js
// header comments) has no vision input, so this extracts everything a
// vision model would normally provide FOR it: dimensions, format, EXIF,
// and — the piece that actually enables "replicate the colors" — a real
// dominant/palette color extraction computed from the actual pixels via
// sharp (libvips), not a description pulled from thin air.
//
// This deliberately does NOT attempt OCR or object recognition — that
// would require a real vision model or a heavyweight ML dependency this
// codebase doesn't have. What it provides is honest: precise color data,
// geometry, and file metadata, which covers "what does this look like /
// what palette is this / recreate this as a gradient or swatch" well
// without pretending to see content it can't actually identify.

import sharp from 'sharp';
import fs from 'node:fs/promises';
import { safePath } from './workspace.js';

function toHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Simple k-means-ish palette extraction: downsample heavily first (color
// clustering on the full-res pixel grid is unnecessary and slow — a 64x64
// downsample preserves the color distribution just fine), then bucket
// pixels into a coarse 3D histogram and take the densest buckets as the
// palette. This is intentionally simple rather than a full k-means
// implementation — it's fast, dependency-free beyond sharp, and good
// enough for "what colors is this image" rather than pixel-perfect
// clustering.
async function extractPalette(buffer, count = 6) {
  const { data, info } = await sharp(buffer)
    .resize(64, 64, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map(); // bucketKey -> { sum: [r,g,b], n }
  const step = 16; // bucket width per channel (256/16 = 16 buckets/channel)
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = `${r >> 4}_${g >> 4}_${b >> 4}`;
    const bucket = buckets.get(key) || { sum: [0, 0, 0], n: 0 };
    bucket.sum[0] += r; bucket.sum[1] += g; bucket.sum[2] += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count);
  const total = [...buckets.values()].reduce((s, b) => s + b.n, 0);

  return sorted.map(b => {
    const avg = [b.sum[0] / b.n, b.sum[1] / b.n, b.sum[2] / b.n];
    return { hex: toHex(avg), rgb: avg.map(Math.round), share: Math.round((b.n / total) * 100) };
  });
}

/**
 * Analyzes an image already downloaded into the workspace (via
 * receive_file). Returns dimensions, format, file size, EXIF (if
 * present), average color, and a dominant-color palette with each
 * color's approximate share of the image — real data computed from the
 * actual pixels, suitable for the model to reason about or replicate
 * (e.g. generating a matching CSS palette, an SVG swatch, a gradient).
 */
export async function analyzeImage(workspace, relPath) {
  const filePath = safePath(workspace, relPath, { mustExist: true });
  const buffer = await fs.readFile(filePath);

  const img = sharp(buffer);
  const metadata = await img.metadata();
  const stats = await img.stats();
  const palette = await extractPalette(buffer);

  const avgColor = stats.channels.slice(0, 3).map(c => Math.round(c.mean));

  return {
    format: metadata.format || null,
    width: metadata.width || null,
    height: metadata.height || null,
    aspect_ratio: metadata.width && metadata.height
      ? Number((metadata.width / metadata.height).toFixed(3))
      : null,
    file_size_bytes: buffer.length,
    has_alpha: !!metadata.hasAlpha,
    orientation: metadata.orientation || null,
    exif: metadata.exif ? summarizeExif(metadata) : null,
    average_color: { hex: toHex(avgColor), rgb: avgColor },
    dominant_colors: palette,
    is_likely_grayscale: palette.every(c => {
      const [r, g, b] = c.rgb;
      return Math.max(r, g, b) - Math.min(r, g, b) < 12;
    }),
  };
}

function summarizeExif(metadata) {
  // sharp exposes a few high-value EXIF-derived fields directly on
  // metadata rather than requiring raw EXIF buffer parsing — enough for
  // "was this a photo, what device, was it edited" without adding
  // another dependency just to parse TIFF-format EXIF tags.
  const out = {};
  if (metadata.exifOrientation) out.orientation = metadata.exifOrientation;
  if (metadata.density) out.density_dpi = metadata.density;
  if (metadata.space) out.color_space = metadata.space;
  if (metadata.icc) out.has_icc_profile = true;
  return Object.keys(out).length ? out : null;
}
