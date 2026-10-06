import { Vector3 } from 'three';
import './style.css';
import { CameraRig } from './camera';
import { byline, curate, loadCollection, loadCuration, type Kind } from './data';
import { Gallery } from './gallery';
import { buildLayouts, type Layout, type LayoutName } from './layouts';
import { createPanel, createSearch, esc } from './ui';

const canvas = document.getElementById('wall') as HTMLCanvasElement;
const intro = document.getElementById('intro')!;
const label = document.getElementById('hover')!;
const labelsEl = document.getElementById('labels')!;
const hangs = [...document.querySelectorAll<HTMLButtonElement>('#hangs button')];
const kinds = [...document.querySelectorAll<HTMLButtonElement>('#kinds button')];
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

const [full, curation] = await Promise.all([
  loadCollection().catch((e) => {
    document.documentElement.classList.add('failed');
    throw e;
  }),
  loadCuration(),
]);
// Only what the curator has let through hangs on the wall.
const collection = { ...full, works: curate(full.works, curation) };
const works = collection.works;
const n = works.length;
document.querySelectorAll('[data-count]').forEach((el) => (el.textContent = n.toLocaleString('en')));
{
  const years = works.map((w) => w.year).sort((a, b) => a - b);
  document.querySelectorAll('[data-span]').forEach((el) => (el.textContent = `${years[Math.floor(years.length * 0.01)]} — ${years.at(-1)}`));
}

const all = works.map((_, i) => i);
let layouts = buildLayouts(works, all);
let kind: Kind | 'all' = 'all';
let artist: string | null = null;
const shown = new Uint8Array(n).fill(1);
const gallery = new Gallery(canvas, collection);
const rig = new CameraRig(gallery.camera, canvas);
rig.reduced = reducedQuery.matches;
reducedQuery.addEventListener('change', () => (rig.reduced = reducedQuery.matches));

// ——— Animated state ———
let layout: Layout = layouts.spectrum;
const from = new Float32Array(n * 4);
const fromZ = new Float32Array(n);
const delay = new Float32Array(n);
const arc = new Float32Array(n);
const tilt = new Float32Array(n);
const hover = new Float32Array(n);
const dim = new Float32Array(n).fill(1);
let morph: { start: number; duration: number; spread: number } | null = null;
let focus = -1;
/** The camera height that frames the work in focus. */
let focusZ = 0;
let hovered = -1;
let pointer: { x: number; y: number; t: number } | null = null;

const WHITE = [0.957, 0.957, 0.949];
const room = [...WHITE];
let roomCss = false;
const hexRgb = (hex: string) => {
  const c = parseInt(hex.slice(1), 16);
  return [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
};

const rand = (() => {
  let s = 9;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();

/** Height at which a rectangle of the wall fits the screen. */
function fitZ(w: number, h: number, margin = 1.12) {
  const tan = Math.tan((gallery.camera.fov * Math.PI) / 360);
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  return Math.max(h / 2 / tan, ((w / 2 / tan) * vh) / vw) * margin;
}
function overviewZ(l: Layout) {
  const b = l.bounds;
  return Math.max(fitZ(b.maxX - b.minX, b.maxY - b.minY, 1.08), fitZ(640, 640));
}
const centre = (l: Layout) => [(l.bounds.minX + l.bounds.maxX) / 2, (l.bounds.minY + l.bounds.maxY) / 2];

/** Re-hang: every painting flies from where it is now to its place in the next layout. */
function rehang(next: Layout, anchor = -1) {
  const now = performance.now();
  const r = gallery.rect;
  from.set(r);
  for (let i = 0; i < n; i++) fromZ[i] = gallery.lift[i * 2];
  const to = next.rects;
  for (let i = 0; i < n; i++) if (!shown[i]) to.set([r[i * 4], r[i * 4 + 1], 0, 0], i * 4);
  const [ax, ay] = anchor >= 0 ? [to[anchor * 4], to[anchor * 4 + 1]] : centre(next);
  let far = 1;
  for (let i = 0; i < n; i++) far = Math.max(far, Math.hypot(to[i * 4] - ax, to[i * 4 + 1] - ay));
  for (let i = 0; i < n; i++) {
    const travel = Math.hypot(to[i * 4] - r[i * 4], to[i * 4 + 1] - r[i * 4 + 1]);
    // A wave that spreads out from the anchor, a little ragged.
    delay[i] = (Math.hypot(to[i * 4] - ax, to[i * 4 + 1] - ay) / far) * 700 + rand() * 260;
    arc[i] = Math.min(1600, travel * 0.22) * (0.5 + rand());
    tilt[i] = (rand() - 0.5) * 1.1;
  }
  layout = next;
  morph = { start: now, duration: rig.reduced ? 1 : 1250, spread: rig.reduced ? 0 : 1 };
  if (rig.reduced) delay.fill(0);
  for (const b of hangs) b.setAttribute('aria-pressed', String(b.dataset.hang === next.name));
  document.body.dataset.hang = next.name;
  renderLabels();
}

function setHang(name: LayoutName) {
  if (layout.name === name && !morph) return;
  // Keep what you're looking at in front of you while the room rearranges.
  let anchor = focus;
  if (anchor < 0 && rig.pos.z < overviewZ(layout) * 0.35) {
    const c = rig.toWall(canvas.clientWidth / 2, canvas.clientHeight / 2);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(gallery.rect[i * 4] - c.x, gallery.rect[i * 4 + 1] - c.y);
      if (d < best) [best, anchor] = [d, i];
    }
  }
  const next = layouts[name];
  rehang(next, anchor);
  if (focus >= 0) focusOn(focus, true);
  else if (anchor >= 0) rig.flyTo(next.rects[anchor * 4], next.rects[anchor * 4 + 1], rig.pos.z, 1700);
  else {
    const [x, y] = centre(next);
    rig.maxZ = overviewZ(next) * 1.6;
    rig.flyTo(x, y, overviewZ(next), 1700);
  }
  rig.maxZ = Math.max(overviewZ(next) * 1.6, 2000);
}

// ——— Focus ———
const panel = createPanel(collection.sources, {
  onClose: () => unfocus(),
  onStep: (d) => step(d),
  onColour: (hex) => walkIntoColour(hex),
  onArtist: (name) => setArtist(name),
});

function focusOn(i: number, keepMorph = false) {
  if (!(i >= 0 && i < n)) return;
  focus = i;
  const rect = keepMorph ? layout.rects : gallery.rect;
  const [x, y, w, h] = [rect[i * 4], rect[i * 4 + 1], rect[i * 4 + 2], rect[i * 4 + 3]];
  const side = innerWidth > 820;
  // Desktop: the label sits to the right. Phones: a compact label below, the top bar above,
  // and the work gets everything in between (the closed sheet's height, measured).
  const panelW = side ? Math.min(600, innerWidth * 0.42) : 0;
  panel.show(works[i], i, n);
  const panelH = side ? 0 : panel.peek();
  const top = side ? 0 : 58;
  const vw = canvas.clientWidth - panelW;
  const vh = canvas.clientHeight - panelH - top;
  const tan = Math.tan((gallery.camera.fov * Math.PI) / 360);
  // Fit the work into the space left over, then shift the camera to centre it there.
  const z = Math.max((h / 2 / tan) * (canvas.clientHeight / vh), (w / 2 / tan) * (canvas.clientHeight / vw)) * (side ? 1.18 : 1.05);
  const upp = (2 * z * tan) / canvas.clientHeight;
  const cy = top + vh / 2 - canvas.clientHeight / 2; // where the work's centre lands, from the screen's centre
  rig.flyTo(x + (panelW / 2) * upp, y + cy * upp, z);
  focusZ = z;
  document.body.classList.add('focused');
}

function unfocus() {
  if (focus < 0) return;
  focus = -1;
  panel.hide();
  document.body.classList.remove('focused');
  rig.flyTo(rig.pos.x, rig.pos.y, Math.min(rig.maxZ, rig.pos.z * 2.6), 900);
}

function step(d: number) {
  if (focus < 0) return;
  // Wrap around the works on show (an artist or medium filter shortens the list).
  const order = layout.order;
  if (!order.length) return;
  const k = order.indexOf(focus);
  const next = order[(((k + d) % order.length) + order.length) % order.length];
  if (next !== undefined) focusOn(next);
}

/** From a swatch to the part of the colour wheel where that colour lives. */
function walkIntoColour(hex: string) {
  const c = parseInt(hex.slice(1), 16);
  const rgb = [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  const nearest = works
    .flatMap((w, i) => (shown[i] ? [{ w, i }] : []))
    .map(({ w, i }) => {
      const p = w.palette.slice(0, 3).map((h) => {
        const v = parseInt(h.slice(1), 16);
        return Math.hypot((v >> 16) / 255 - rgb[0], ((v >> 8) & 255) / 255 - rgb[1], (v & 255) / 255 - rgb[2]);
      });
      return { i, d: Math.min(...p) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 24);
  focus = -1;
  panel.hide();
  document.body.classList.remove('focused');
  if (layout.name !== 'spectrum') rehang(layouts.spectrum, nearest[0].i);
  const r = layouts.spectrum.rects;
  const x = nearest.reduce((s, p) => s + r[p.i * 4], 0) / nearest.length;
  const y = nearest.reduce((s, p) => s + r[p.i * 4 + 1], 0) / nearest.length;
  rig.flyTo(x, y, fitZ(900, 900), 1900);
}

// ——— Input ———
rig.onTap = (cx, cy) => {
  dismissIntro();
  if (morph) return;
  // In focus, everything around the work is out of reach: a click there steps back.
  if (focus >= 0) {
    const p = rig.toWall(cx, cy);
    if (gallery.pick(p.x, p.y) !== focus) unfocus();
    return;
  }
  const p = rig.toWall(cx, cy);
  const i = gallery.pick(p.x, p.y);
  if (i >= 0) focusOn(i);
};
rig.onUserMove = () => dismissIntro();
// In focus there's nothing around the work to travel to: dragging it away closes it.
// Zoomed in past the frame, a drag pans over the details instead.
rig.holdStill = () => focus >= 0 && rig.pos.z > focusZ * 0.9;
rig.onDragAway = () => unfocus();
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') pointer = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerleave', () => (pointer = null));

const search = createSearch(
  works,
  (i) => {
    dismissIntro();
    if (!shown[i]) {
      kind = 'all';
      artist = null;
      applyFilter();
      setTimeout(() => focusOn(i, true), 50);
    } else focusOn(i);
  },
  (name) => {
    dismissIntro();
    setArtist(name);
  },
);

/** One medium, or everything; one artist, or everyone. The rest shrink away and the wall closes ranks. */
function setKind(next: Kind | 'all') {
  if (next === kind) return;
  kind = next;
  applyFilter();
}
function setArtist(name: string | null) {
  if (name === artist) return;
  artist = name;
  const url = new URL(location.href);
  if (name) url.searchParams.set('artist', name);
  else url.searchParams.delete('artist');
  history.replaceState(null, '', url);
  applyFilter();
}
function applyFilter(fly = true) {
  const ofArtist = all.filter((i) => !artist || byline(works[i]) === artist);
  const ids = ofArtist.filter((i) => kind === 'all' || works[i].type === kind);
  // An artist with no works in this medium: show all their media instead of an empty wall.
  if (!ids.length && kind !== 'all') {
    kind = 'all';
    return applyFilter(fly);
  }
  shown.fill(0);
  for (const i of ids) shown[i] = 1;
  layouts = buildLayouts(works, ids);
  if (focus >= 0 && !shown[focus]) {
    focus = -1;
    panel.hide();
    document.body.classList.remove('focused');
  }
  for (const b of kinds) {
    const k = b.dataset.kind as Kind | 'all';
    const count = k === 'all' ? ofArtist.length : ofArtist.filter((i) => works[i].type === k).length;
    b.querySelector('span')!.textContent = count.toLocaleString('en');
    b.hidden = !count;
    b.setAttribute('aria-pressed', String(k === kind));
  }
  artistChip.hidden = !artist;
  if (artist) artistChip.querySelector('b')!.textContent = artist;
  artistChip.querySelector('span:not(.chip-label)')!.textContent = `${ids.length.toLocaleString('en')} ${ids.length === 1 ? 'work' : 'works'}`;
  document.body.classList.toggle('by-artist', !!artist);
  const l = layouts[layout.name];
  rehang(l, focus);
  rig.maxZ = Math.max(overviewZ(l) * 1.6, 2000);
  if (!fly) return;
  if (focus >= 0) focusOn(focus, true);
  else {
    const [x, y] = centre(l);
    rig.flyTo(x, y, overviewZ(l), 1600);
  }
}
const artistChip = document.getElementById('artist-chip')!;
artistChip.querySelector('button')!.addEventListener('click', () => setArtist(null));
for (const b of kinds) b.addEventListener('click', () => (dismissIntro(), setKind(b.dataset.kind as Kind | 'all')));

addEventListener('keydown', (e) => {
  if (search.open || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea')) return;
  if (e.key === '/') {
    e.preventDefault();
    search.show();
  } else if (e.key === 'Escape') {
    if (panel.expanded) panel.collapse();
    else unfocus();
  }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
  else if (e.key === '1') setHang('spectrum');
  else if (e.key === '2') setHang('chronology');
  else if (e.key === '+' || e.key === '=') rig.zoomAt(innerWidth / 2, innerHeight / 2, 0.7);
  else if (e.key === '-') rig.zoomAt(innerWidth / 2, innerHeight / 2, 1.4);
  else return;
  dismissIntro();
});
for (const b of hangs) b.addEventListener('click', () => (dismissIntro(), setHang(b.dataset.hang as LayoutName)));
document.getElementById('open-search')!.addEventListener('click', () => search.show());

let introGone = false;
function dismissIntro() {
  if (introGone) return;
  introGone = true;
  intro.classList.add('gone');
}

/** The logo: back to the opening view, everything on show, the colour wheel, the intro. */
function goHome() {
  if (search.open) document.querySelector<HTMLDialogElement>('#search')!.close();
  focus = -1;
  panel.hide();
  document.body.classList.remove('focused');
  if (kind !== 'all' || artist) {
    kind = 'all';
    setArtist(null);
    applyFilter(false);
  }
  if (layout.name !== 'spectrum') rehang(layouts.spectrum);
  const l = layouts.spectrum;
  const [x, y] = centre(l);
  rig.maxZ = Math.max(overviewZ(l) * 1.6, 2000);
  rig.flyTo(x, y, overviewZ(l), 1600);
  introGone = false;
  intro.classList.remove('gone', 'settled');
}
document.getElementById('home')!.addEventListener('click', (e) => {
  e.preventDefault();
  goHome();
});

// ——— Labels for the time-based hangs ———
let labelEls: HTMLElement[] = [];
function renderLabels() {
  labelsEl.replaceChildren(
    ...(labelEls = layout.labels.map((l) => {
      const s = document.createElement('span');
      s.textContent = l.text;
      if (l.major) s.className = 'major';
      return s;
    })),
  );
}
const v = new Vector3();
const toScreen = (x: number, y: number) => {
  v.set(x, y, 0).project(gallery.camera);
  return [(v.x * 0.5 + 0.5) * canvas.clientWidth, (-v.y * 0.5 + 0.5) * canvas.clientHeight];
};
let labelSize = 0;
function placeLabels(visible: boolean) {
  labelsEl.classList.toggle('visible', visible);
  if (!visible) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // The years sit on the line, in the gap between the works above and below it, sized to
  // fit. When the works are too small for that gap to hold a year, the years drop to a
  // ruler under the river (kept on screen, clear of the hang bar) instead of covering them.
  const gap = Math.abs(toScreen(0, 7)[1] - toScreen(0, -7)[1]);
  const onLine = gap >= 18;
  const size = Math.round(onLine ? Math.min(34, gap * 0.82) : 15);
  if (size !== labelSize) labelsEl.style.setProperty('--size', `${(labelSize = size)}px`);
  labelsEl.classList.toggle('ruler', !onLine);
  const floor = (document.getElementById('hangs')?.getBoundingClientRect().top ?? h) - size;
  const rulerY = Math.min(toScreen(0, layout.bounds.minY)[1] + size, floor);
  let lastRight = -1e9;
  layout.labels.forEach((l, k) => {
    const [x, lineY] = toScreen(l.x, l.y);
    const y = onLine ? lineY : rulerY;
    const el = labelEls[k];
    // Thin the years out when they'd run into each other.
    const half = (l.text.length * 0.62 * size + 16) / 2;
    const on = x > -80 && x < w + 80 && y > -40 && y < h + 40 && x - half > lastRight + 6;
    if (on) lastRight = x + half;
    el.style.display = on ? '' : 'none';
    if (on) el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  });
}

// ——— Opening: the collection gathers out of the dark into the colour wheel ———
function scatter() {
  const r = gallery.rect;
  const b = layout.bounds;
  const R = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const d = R * (0.3 + rand() * 0.9);
    r.set([Math.cos(a) * d, Math.sin(a) * d, layout.rects[i * 4 + 2], layout.rects[i * 4 + 3]], i * 4);
    gallery.lift[i * 2] = -4000 + rand() * 9000;
  }
}

function resize() {
  gallery.resize();
  rig.maxZ = Math.max(overviewZ(layout) * 1.6, 2000);
}
addEventListener('resize', resize);
resize();
renderLabels();
document.body.dataset.hang = layout.name;
const [cx, cy] = centre(layout);
rig.pos.set(cx, cy, overviewZ(layout) * 1.35);
scatter();
gallery.onReady = () => {
  document.body.classList.add('ready');
  rehang(layouts.spectrum);
  if (morph && !rig.reduced) morph.duration = 2300;
  for (let i = 0; i < n; i++) delay[i] = rand() * 1500;
  rig.flyTo(cx, cy, overviewZ(layout), 3200);
  // A shared link can open on one artist's work.
  const wanted = new URL(location.href).searchParams.get('artist');
  if (wanted && works.some((w) => byline(w) === wanted)) setTimeout(() => setArtist(wanted), 2600);
};

// ——— Frame loop ———
let last = performance.now();
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  rig.update(dt);

  const r = gallery.rect;
  const lift = gallery.lift;
  const to = layout.rects;
  let morphing = false;
  if (morph) {
    const elapsed = now - morph.start;
    let all = true;
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (elapsed - delay[i] * morph.spread) / morph.duration));
      if (t < 1) all = false;
      const e = easeInOut(t);
      for (let k = 0; k < 4; k++) r[i * 4 + k] = from[i * 4 + k] + (to[i * 4 + k] - from[i * 4 + k]) * e;
      lift[i * 2] = fromZ[i] * (1 - e) + Math.sin(Math.PI * e) * arc[i];
      lift[i * 2 + 1] = Math.sin(Math.PI * e) * tilt[i];
    }
    morphing = !all;
    if (all) morph = null;
  } else {
    r.set(to);
  }

  // Hover and focus, eased per painting.
  let target = -1;
  let overFocus = false;
  // No hover while the wall moves: works popping forward under a sweeping cursor read as flicker.
  if (pointer && !morphing && !rig.moving && now - pointer.t < 4000) {
    const p = rig.toWall(pointer.x, pointer.y);
    target = gallery.pick(p.x, p.y);
    // In focus the work is already chosen: no hover lift, no pointer hand.
    overFocus = focus >= 0 && target === focus;
    if (focus >= 0) target = -1;
  }
  if (target !== hovered) {
    hovered = target;
    if (hovered >= 0 && hovered !== focus) {
      const w = works[hovered];
      label.innerHTML = `<b>${String(hovered + 1).padStart(4, '0')}</b><i>${esc(w.title)}</i><span>${esc(byline(w))}, ${esc(w.date)}</span>`;
    }
  }
  label.classList.toggle('visible', hovered >= 0 && hovered !== focus);
  if (pointer) label.style.transform = `translate(${pointer.x + 18}px, ${pointer.y + 18}px)`;
  canvas.style.cursor = focus >= 0 ? (overFocus ? 'default' : 'zoom-out') : hovered >= 0 ? 'pointer' : 'grab';

  const k = 1 - Math.exp(-dt * 10);
  const kd = 1 - Math.exp(-dt * 4);
  for (let i = 0; i < n; i++) {
    hover[i] += ((i === hovered ? 1 : 0) - hover[i]) * k;
    dim[i] += ((!shown[i] ? 0 : focus < 0 || i === focus ? 1 : 0.012) - dim[i]) * kd;
    if (!morphing) {
      // Hovered works step forward a little.
      lift[i * 2] = hover[i] * 0.05 * Math.max(r[i * 4 + 2], r[i * 4 + 3]);
      lift[i * 2 + 1] = 0;
      r[i * 4 + 2] *= 1 + 0.05 * hover[i];
      r[i * 4 + 3] *= 1 + 0.05 * hover[i];
    }
    gallery.light[i] = dim[i];
  }

  // The room takes on the colour of the painting in focus.
  const want = focus >= 0 ? hexRgb(works[focus].palette[0]) : WHITE;
  const kr = 1 - Math.exp(-dt * 3.5);
  let moved = 0;
  for (let c = 0; c < 3; c++) {
    const d = (want[c] - room[c]) * kr;
    room[c] += d;
    moved += Math.abs(d);
  }
  const dark = 0.2126 * room[0] + 0.7152 * room[1] + 0.0722 * room[2] < 0.5;
  gallery.setRoom(room, dark ? [1, 1, 1] : [0, 0, 0]);
  if (moved > 1e-4 || !roomCss) {
    roomCss = true;
    const rs = document.documentElement.style;
    rs.setProperty('--bg', `rgb(${room.map((v) => Math.round(v * 255)).join(' ')})`);
    // The phone's sheet: the room's colour moved away from mid-grey, so its text gains contrast.
    const sheet = room.map((v) => (dark ? v * 0.8 : v + (1 - v) * 0.55));
    rs.setProperty('--sheet', `rgb(${sheet.map((v) => Math.round(v * 255)).join(' ')})`);
    rs.setProperty('--fg', dark ? '#f6f5f1' : '#0c0c0c');
    rs.setProperty('--fg-soft', dark ? 'rgb(246 245 241 / 0.62)' : 'rgb(12 12 12 / 0.55)');
    rs.setProperty('--line', dark ? 'rgb(246 245 241 / 0.22)' : 'rgb(12 12 12 / 0.14)');
  }

  placeLabels(!morphing && layout.labels.length > 0);
  gallery.render(focus, morphing);
}
requestAnimationFrame(frame);
if (import.meta.env.DEV) Object.assign(window, { __dbg: () => ({ focus, cam: rig.pos.toArray(), rect: focus >= 0 ? [...gallery.rect.slice(focus * 4, focus * 4 + 4)] : null, to: focus >= 0 ? [...layout.rects.slice(focus * 4, focus * 4 + 4)] : null, dim: focus >= 0 ? dim[focus] : null, shown: focus >= 0 ? shown[focus] : null }) });
