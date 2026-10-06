// Shared helpers for the collection importers.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRetry(url, as = 'json', init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...init });
      if (res.status === 404) return null;
      // Blocked by bot protection: retrying only digs deeper.
      if (res.status === 403) throw Object.assign(new Error(`403 ${url}`), { fatal: true });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return as === 'json' ? await res.json() : as === 'text' ? await res.text() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4 || e.fatal) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** Run `fn` over items with a fixed number of workers. */
export async function pool(items, workers, fn) {
  const queue = [...items];
  const out = [];
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let item; (item = queue.shift()) !== undefined; ) out.push(await fn(item));
    }),
  );
  return out;
}

/** Deterministic shuffle, so caps pick the same works on every run. */
export function shuffled(items, seed = 7) {
  const a = [...items];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** "… 50.8 × 61 cm …" → [width, height] in cm (museums write height first). */
export function parseCm(text) {
  const m = /([\d.]+)\s*[x×]\s*([\d.]+)\s*cm/i.exec(text ?? '');
  return m ? [Number(m[2]), Number(m[1])] : null;
}

/** The modern window: paintings from 1860, works on paper from 1880, nothing after 1930. */
export const inWindow = (type, year) => year != null && year <= 1930 && year >= (type === 'Painting' ? 1860 : 1880);

/** Studies, sketches, designs and pieces of something larger, in the languages the museums write in. */
const UNFINISHED =
  /\b(stud(y|ies|ie|ien)|sketch|skizze|entwurf|esquisse|étude|schets|studie|skiss|utkast|luonnos|tutkielma|fragment|detail|part of|teil|del av|osa)\b|skizzenbuch|sketchbook|luonnoskirja/i;
export const unfinished = (title) => UNFINISHED.test(title ?? '');

/**
 * A curated pick rather than everything: no anonymous works, no studies or sketches, and a
 * few works per artist, so one prolific painter doesn't flood the wall. The artists a
 * collection is known for get room for their whole range.
 */
export function select(works, { key = [], cap = 12, keyCap = 60, drawings = 25 }) {
  const isKey = (a) => key.some((k) => a?.toLowerCase().includes(k.toLowerCase()));
  const byArtist = new Map();
  for (const w of works) {
    if (!w.artist || /unknown|anonym|tuntematon|okänd|onbekend|unbekannt|ei tiedossa/i.test(w.artist)) continue;
    if (unfinished(w.title)) continue;
    // Works on paper only by the names that matter; the wall has plenty of prints already.
    if (w.type !== 'Painting' && !isKey(w.artist)) continue;
    (byArtist.get(w.artist) ?? byArtist.set(w.artist, []).get(w.artist)).push(w);
  }
  const out = [];
  for (const [artist, list] of byArtist) {
    const paintings = shuffled(list.filter((w) => w.type === 'Painting'));
    const paper = shuffled(list.filter((w) => w.type !== 'Painting'));
    out.push(...paintings.slice(0, isKey(artist) ? keyCap : cap), ...paper.slice(0, drawings));
  }
  return out;
}

/** "1890" or "1890–95"-style display dates from a year range. */
export const span = (y0, y1) => (!y1 || y1 === y0 ? String(y0) : `${y0}–${y1}`);
