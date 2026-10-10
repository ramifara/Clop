import sharp from 'sharp';

// Deterministic test images: the same pixels on every platform, so recorded output sizes stay comparable.
function random(seed: number) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** A photo-like image: smooth colour waves with grain. */
export function photo(width: number, height: number, seed = 1) {
  const next = random(seed), data = Buffer.alloc(width * height * 3);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const grain = (next() - 0.5) * 24;
    data[i++] = 128 + 90 * Math.sin(x / 37 + y / 53) + grain;
    data[i++] = 128 + 80 * Math.sin(x / 23 - y / 41 + 1) + grain;
    data[i++] = 128 + 70 * Math.cos((x + y) / 61) + grain;
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/** A screenshot-like image: flat rectangles in a few colours with hard edges. */
export function graphic(width: number, height: number, { seed = 2, alpha = false } = {}) {
  const next = random(seed), channels = alpha ? 4 : 3, data = Buffer.alloc(width * height * channels, 255);
  const colours = [[32, 96, 160], [230, 230, 235], [250, 180, 40], [40, 40, 48], [120, 200, 120], [200, 60, 80]];
  for (let n = 0; n < 400; n++) {
    const [r, g, b] = colours[Math.floor(next() * colours.length)];
    const x0 = Math.floor(next() * width), y0 = Math.floor(next() * height), w = 4 + Math.floor(next() * width / 6), h = 2 + Math.floor(next() * height / 12);
    const a = alpha && next() < 0.3 ? 128 : 255;
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * channels;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; if (alpha) data[i + 3] = a;
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

/** Two colours of 1-pixel lines on white: few colours, but the hard edges cost JPEG a lot. */
export function lines(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i += 3) {
    if ((x >> 6) % 3 === 0 && y % 3 === 0) data.fill(30, i, i + 3);
    else if ((y >> 5) % 4 === 1 && x % 4 < 2) { data[i] = 20; data[i + 1] = 90; data[i + 2] = 200; }
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/** Frames of a square moving over a gradient, `delays` in milliseconds. */
export async function animation(format: 'gif' | 'webp', { frames = 12, width = 96, height = 64, delays = Array(frames).fill(80), loop = 0 }: { frames?: number; width?: number; height?: number; delays?: number[]; loop?: number } = {}) {
  const pages: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = Math.abs(x - (f * width) / frames - 8) < 8 && Math.abs(y - height / 2) < 8;
      data[i++] = inside ? 240 : (x * 255) / width; data[i++] = inside ? 40 : (y * 255) / height; data[i++] = inside ? 40 : 128;
    }
    pages.push(await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer());
  }
  const joined = sharp(pages, { join: { animated: true } });
  return (format === 'gif' ? joined.gif({ delay: delays, loop }) : joined.webp({ delay: delays, loop, quality: 90 })).toBuffer();
}
