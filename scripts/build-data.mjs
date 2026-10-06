// Builds the Open Wall pool from the open-access collections in ./sources.
// Usage: npm run data            (re-uses cached metadata and images)
//        npm run data -- --fresh (asks the museums again)
// Output: src/generated/wall.json — every work, its palette and atlas position
//         public/atlas/atlas-<n>-<hash>.webp — thumbnails packed into GPU-friendly sheets
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { cleveland } from './sources/cleveland.mjs';
import { met } from './sources/met.mjs';
import { nga } from './sources/nga.mjs';
import { smk } from './sources/smk.mjs';
import { belvedere } from './sources/belvedere.mjs';
import { fng } from './sources/fng.mjs';
import { nationalmuseum } from './sources/nationalmuseum.mjs';
import { rijksmuseum } from './sources/rijksmuseum.mjs';
import { fetchRetry, pool } from './sources/util.mjs';

const SOURCES = { cma: cleveland, met, nga, smk, blv: belvedere, rkm: rijksmuseum, fng, nms: nationalmuseum };
const CACHE = new URL('../.cache/', import.meta.url);
const IMAGES = new URL('img/', CACHE);
const ATLAS_DIR = new URL('../public/atlas/', import.meta.url);
const OUT = new URL('../src/generated/wall.json', import.meta.url);

/** Thumbnail height in the atlas, in pixels. */
const THUMB = 64;
const MAX_THUMB_W = 256;
const SHEET = 4096;
const PAD = 2;

await mkdir(IMAGES, { recursive: true });
await mkdir(ATLAS_DIR, { recursive: true });
await mkdir(new URL('../src/generated/', import.meta.url), { recursive: true });
const exists = (u) => stat(u).then(() => true, () => false);
const fresh = process.argv.includes('--fresh');

// ——— 1. Metadata, per museum, cached ———
const works = [];
for (const [name, load] of Object.entries(SOURCES)) {
  const file = new URL(`meta-${name}.json`, CACHE);
  let list;
  if (!fresh && (await exists(file))) list = JSON.parse(await readFile(file, 'utf8'));
  else {
    try {
      list = await load();
      await writeFile(file, JSON.stringify(list));
    } catch (e) {
      // One museum being unreachable shouldn't hold up the others.
      console.warn(`✗ ${name} skipped: ${e.message}`);
      list = [];
    }
  }
  console.log(`${name}: ${list.length} works`);
  works.push(...list);
}

// ——— 2. A small image of each, for the atlas and the palette ———
let done = 0;
const failed = new Set();
await pool(works, 10, async (w) => {
  const file = new URL(`${w.key.replace(/[^\w.-]/g, '_')}.jpg`, IMAGES);
  const legacy = w.source === 'cma' ? new URL(`web/${w.key.slice(4)}.jpg`, CACHE) : null;
  try {
    if (legacy && (await exists(legacy))) w.file = legacy;
    else {
      if (!(await exists(file))) {
        const buf = await fetchRetry(w.thumb, 'buffer');
        if (!buf) throw new Error('missing');
        await writeFile(file, buf);
      }
      w.file = file;
    }
  } catch (e) {
    failed.add(w);
    console.warn(`✗ ${w.key} ${e.message}`);
  }
  if (++done % 500 === 0) console.log(`images ${done} / ${works.length}`);
});

// ——— 3. Palettes: k-means in RGB on a tiny copy ———
function kmeans(px, k = 5) {
  const n = px.length / 3;
  const c = [[px[0], px[1], px[2]]];
  while (c.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i += 3) {
      const d = Math.min(...c.map((q) => (px[i * 3] - q[0]) ** 2 + (px[i * 3 + 1] - q[1]) ** 2 + (px[i * 3 + 2] - q[2]) ** 2));
      if (d > bestD) [best, bestD] = [i, d];
    }
    c.push([px[best * 3], px[best * 3 + 1], px[best * 3 + 2]]);
  }
  let sum;
  for (let iter = 0; iter < 12; iter++) {
    sum = c.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (px[i * 3] - c[j][0]) ** 2 + (px[i * 3 + 1] - c[j][1]) ** 2 + (px[i * 3 + 2] - c[j][2]) ** 2;
        if (d < bd) [bi, bd] = [j, d];
      }
      const s = sum[bi];
      s[0] += px[i * 3];
      s[1] += px[i * 3 + 1];
      s[2] += px[i * 3 + 2];
      s[3]++;
    }
    sum.forEach((s, j) => s[3] && (c[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
  }
  return c.map((q, j) => ({ rgb: q, weight: sum[j][3] / n })).filter((q) => q.weight > 0).sort((a, b) => b.weight - a.weight);
}

function hsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
const hex = (q) => '#' + q.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ——— 4. Thumbnails and atlas packing (rows of equal height) ———
const usable = works.filter((w) => !failed.has(w));
const thumbs = [];
done = 0;
await pool(usable, 8, async (w) => {
  try {
    const img = sharp(w.file.pathname).rotate();
    const meta = await img.metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    w.ar = rotated ? meta.height / meta.width : meta.width / meta.height;
    if (!(w.ar > 1 / 6 && w.ar < 6)) return;
    const tw = Math.min(MAX_THUMB_W, Math.max(8, Math.round(THUMB * w.ar)));
    const [thumb, small] = await Promise.all([
      img.clone().resize(tw, THUMB, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer(),
      img.clone().resize(40, 40, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer(),
    ]);
    const scored = kmeans(small).map((p) => ({ ...p, hsl: hsl(p.rgb) }));
    const lead = scored.reduce((a, b) => (b.weight * (0.15 + b.hsl[1]) > a.weight * (0.15 + a.hsl[1]) ? b : a));
    w.palette = scored.map(hex);
    w.weights = scored.map((p) => Math.round(p.weight * 100) / 100);
    w.hue = Math.round(lead.hsl[0]);
    w.sat = Math.round(scored.reduce((n, p) => n + p.weight * p.hsl[1] * (1 - Math.abs(2 * p.hsl[2] - 1)), 0) * 1000) / 1000;
    w.lum = Math.round(scored.reduce((n, p) => n + p.weight * p.hsl[2], 0) * 1000) / 1000;
    thumbs.push({ w, buf: thumb, tw });
  } catch (e) {
    console.warn(`✗ ${w.key} ${e.message}`);
  }
  if (++done % 1000 === 0) console.log(`thumbnails ${done} / ${usable.length}`);
});
// Keep each museum together in the sheets, in a stable order.
thumbs.sort((a, b) => a.w.key.localeCompare(b.w.key, 'en', { numeric: true }));

for (const f of await readdir(ATLAS_DIR)) await rm(new URL(f, ATLAS_DIR));
const sheets = [];
let sheet = null;
let x = 0;
let y = 0;
for (const t of thumbs) {
  if (!sheet || x + t.tw + PAD > SHEET) {
    x = 0;
    y += THUMB + PAD;
    if (!sheet || y + THUMB > SHEET) {
      sheet = { parts: [] };
      sheets.push(sheet);
      y = 0;
    }
  }
  sheet.parts.push({ input: t.buf, raw: { width: t.tw, height: THUMB, channels: 3 }, left: x, top: y });
  t.w.atlas = sheets.length - 1;
  t.w.uv = [x, y, t.tw, THUMB];
  x += t.tw + PAD;
  sheet.height = y + THUMB;
}
const atlases = [];
for (const [i, s] of sheets.entries()) {
  const h = Math.ceil(s.height / 4) * 4;
  const buf = await sharp({ create: { width: SHEET, height: h, channels: 3, background: '#000' } })
    .composite(s.parts)
    .webp({ quality: 80, effort: 5 })
    .toBuffer();
  const name = `atlas-${i}-${createHash('sha1').update(buf).digest('hex').slice(0, 8)}.webp`;
  await writeFile(new URL(name, ATLAS_DIR), buf);
  atlases.push({ file: `/atlas/${name}`, width: SHEET, height: h });
  console.log(`${name}  ${(buf.length / 1e6).toFixed(2)} MB`);
}

const out = {
  sources: {
    cma: { name: 'Cleveland Museum of Art', site: 'clevelandart.org' },
    met: { name: 'The Metropolitan Museum of Art', site: 'metmuseum.org' },
    nga: { name: 'National Gallery of Art', site: 'nga.gov' },
    smk: { name: 'SMK — National Gallery of Denmark', site: 'open.smk.dk' },
    blv: { name: 'Belvedere, Vienna', site: 'belvedere.at' },
    rkm: { name: 'Rijksmuseum, Amsterdam', site: 'rijksmuseum.nl' },
    fng: { name: 'Finnish National Gallery', site: 'kansallisgalleria.fi' },
    nms: { name: 'Nationalmuseum, Stockholm', site: 'nationalmuseum.se' },
  },
  atlases,
  works: thumbs.map(({ w }) => {
    const { file: _f, thumb: _t, ...rest } = w;
    return rest;
  }),
};
await writeFile(OUT, JSON.stringify(out));
console.log(`wrote ${out.works.length} works`);
