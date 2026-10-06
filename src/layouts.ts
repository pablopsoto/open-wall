// Three ways to hang the same collection. Each returns a centre and size per painting,
// in world units (y up), plus labels and bounds for the camera.
import type { Work } from './data';

export type LayoutName = 'spectrum' | 'chronology';

export interface Label {
  x: number;
  y: number;
  text: string;
  major?: boolean;
}

export interface Layout {
  name: LayoutName;
  /** cx, cy, w, h per work. */
  rects: Float32Array;
  /** Reading order: next/previous painting follows it. */
  order: number[];
  labels: Label[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const BOX = 100;
const PITCH = 114;

/** Fit a painting into the uniform box. */
function fit(ar: number): [number, number] {
  return ar >= 1 ? [BOX, BOX / ar] : [BOX * ar, BOX];
}

function bounds(rects: Float32Array) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < rects.length; i += 4) {
    if (!rects[i + 2]) continue; // not on show
    b.minX = Math.min(b.minX, rects[i] - rects[i + 2] / 2);
    b.maxX = Math.max(b.maxX, rects[i] + rects[i + 2] / 2);
    b.minY = Math.min(b.minY, rects[i + 1] - rects[i + 3] / 2);
    b.maxY = Math.max(b.maxY, rects[i + 1] + rects[i + 3] / 2);
  }
  return b;
}

/**
 * An iris of paintings: darkest at the centre, lightest at the rim, and around each ring
 * in order of hue. Old collections are mostly warm browns, so both axes are ranked rather
 * than measured: the whole disc gets used, and the gradient reads at a glance.
 */
function spectrum(works: Work[], ids: number[]): Layout {
  const n = ids.length;
  const R = Math.sqrt(n / Math.PI) + 2;
  const cells: [number, number][] = [];
  for (let x = -Math.ceil(R); x <= R; x++) for (let y = -Math.ceil(R); y <= R; y++) if (x * x + y * y <= R * R) cells.push([x, y]);
  cells.sort((p, q) => p[0] ** 2 + p[1] ** 2 - (q[0] ** 2 + q[1] ** 2));
  cells.length = n;
  const byLight = [...ids].sort((a, b) => works[a].lum - works[b].lum);
  // Hue order starts at crimson, so reds don't split across the seam.
  const hueKey = (i: number) => (works[i].hue + 25) % 360;
  const angle = ([x, y]: [number, number]) => (Math.atan2(x, y) + Math.PI * 2) % (Math.PI * 2);
  const rects = new Float32Array(works.length * 4);
  const reading: number[] = [];
  const BAND = 140;
  for (let k = 0; k < n; k += BAND) {
    const ring = cells.slice(k, k + BAND).sort((p, q) => angle(p) - angle(q));
    const group = byLight.slice(k, k + BAND).sort((a, b) => hueKey(a) - hueKey(b));
    group.forEach((i, j) => {
      const [w, h] = fit(works[i].ar);
      rects.set([ring[j][0] * 106, ring[j][1] * 106, w, h], i * 4);
      reading.push(i);
    });
  }
  return { name: 'spectrum', rects, order: reading, labels: [], bounds: bounds(rects) };
}

/**
 * A river of time: one band per decade, as wide as it needs to be, paintings stacked
 * above and below the line and sorted by colour within each band.
 */
function chronology(works: Work[], ids: number[]): Layout {
  const HALF = 22; // works above (and below) the line per column
  // Bands sized to the span on show: about forty of them, at a round number of years.
  const years = ids.map((i) => works[i].year).sort((a, b) => a - b);
  const lo = years[Math.floor(years.length * 0.01)] ?? 1900;
  const hi = years.at(-1) ?? 1950;
  const STEP = [1, 2, 5, 10, 25, 50].find((s) => (hi - lo) / s <= 45) ?? 50;
  const FIRST = Math.floor(lo / STEP) * STEP;
  const every = STEP <= 2 ? 10 : STEP <= 10 ? 50 : 100;
  const bins = new Map<number, number[]>();
  for (const i of ids) {
    const b = Math.max(FIRST, Math.floor(works[i].year / STEP) * STEP);
    (bins.get(b) ?? bins.set(b, []).get(b)!).push(i);
  }
  const last = Math.max(...bins.keys());
  const rects = new Float32Array(works.length * 4);
  const labels: Label[] = [];
  const order: number[] = [];
  let x = 0;
  for (let b = FIRST; b <= last; b += STEP) {
    const items = (bins.get(b) ?? []).sort((p, q) => works[p].hue - works[q].hue || works[p].lum - works[q].lum);
    if (b % every === 0) labels.push({ x: x - PITCH / 2, y: 0, text: String(b), major: true });
    if (!items.length) {
      x += PITCH * 0.35;
      continue;
    }
    const cols = Math.ceil(items.length / (HALF * 2));
    const perCol = Math.ceil(items.length / cols);
    items.forEach((i, k) => {
      const col = Math.floor(k / perCol);
      const slot = k % perCol;
      // Alternate above and below the line, growing outwards.
      const level = Math.floor(slot / 2);
      const side = slot % 2 ? -1 : 1;
      const [w, h] = fit(works[i].ar);
      rects.set([x + col * PITCH, side * (PITCH / 2 + level * PITCH), w, h], i * 4);
      order.push(i);
    });
    x += cols * PITCH;
  }
  return { name: 'chronology', rects, order, labels, bounds: bounds(rects) };
}

/** Layouts of the works on show; the rest get no size, so they shrink out of sight. */
export function buildLayouts(works: Work[], ids: number[]): Record<LayoutName, Layout> {
  return { spectrum: spectrum(works, ids), chronology: chronology(works, ids) };
}
