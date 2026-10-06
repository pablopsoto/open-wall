// Finnish National Gallery (Ateneum, Sinebrychoff, Kiasma): Finland's golden age, CC0.
// The whole collection comes as one file. https://www.kansallisgalleria.fi/en/search
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fetchRetry, inWindow, select, span } from './util.mjs';

const KEY = ['Schjerfbeck', 'Gallen-Kallela', 'Simberg', 'Edelfelt', 'Thesleff', 'Enckell', 'Järnefelt', 'Halonen', 'Sallinen', 'Wiik', 'Westerholm', 'Pekka Halonen', 'Churberg', 'Sigrid Schauman', 'Magnus von Wright', 'Ferdinand von Wright', 'Munsterhjelm', 'Blomstedt', 'Rissanen', 'Kivijärvi', 'Ilmari Aalto', 'Gogh', 'Gauguin', 'Cézanne', 'Chagall', 'Modigliani', 'Munch', 'Zorn', 'Carl Larsson', 'Hammershøi', 'Bonnard', 'Signac', 'Sisley', 'Pissarro', 'Monet', 'Corot', 'Courbet', 'Rodin'];
const HOST = 'https://kokoelma.kansallisgalleria.fi';
const UNITS = {
  'Ateneumin taidemuseo': 'Ateneum Art Museum',
  'Sinebrychoffin taidemuseo': 'Sinebrychoff Art Museum',
  'Nykytaiteen museo Kiasma': 'Kiasma Museum of Contemporary Art',
  'Valtion taideteostoimikunta': 'State Art Commission',
};
const SUPPORTS = /^(canvas|paper|cardboard|board|wood|panel|plywood|parchment|silk|copper|metal|ivory|glass)$/;
/** ["canvas", "oil"] → "Oil on canvas": the museum lists materials in no fixed order. */
function medium(materials) {
  const names = [...new Set((materials ?? []).map((m) => m.en?.trim()).filter(Boolean))];
  const on = names.filter((n) => SUPPORTS.test(n));
  const with_ = names.filter((n) => !SUPPORTS.test(n));
  const text = with_.length && on.length ? `${with_.join(', ')} on ${on.join(', ')}` : names.join(', ');
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}
const TYPE = { painting: 'Painting', drawing: 'Drawing', 'graphic arts': 'Print', watercolour: 'Drawing', pastel: 'Drawing' };

export async function fng() {
  const file = new URL('../../.cache/fng-objects.json', import.meta.url);
  if (!(await stat(file).catch(() => null))) await writeFile(file, await fetchRetry(`${HOST}/api/v1/objects`, 'buffer', { signal: AbortSignal.timeout(600000) }));
  const works = [];
  for (const o of JSON.parse(await readFile(file, 'utf8'))) {
    if (o.category?.categoryId !== 'artwork' || o.category?.en !== 'artwork') continue; // not parts of works
    const type = (o.classifications ?? []).map((c) => TYPE[c.en]).find(Boolean);
    const img = (o.multimedia ?? []).find((m) => m.license === 'CC0' && m.jpg?.['1000']);
    const y0 = o.yearFrom;
    const y1 = o.yearTo ?? y0;
    if (!type || !img || !y0 || y1 - y0 > 15) continue;
    const year = Math.round((y0 + y1) / 2);
    if (!inWindow(type, year)) continue;
    const p = (o.people ?? []).find((x) => x.role?.en === 'Artist') ?? o.people?.[0];
    const m = o.dimensions?.find((d) => d.unit === 'cm')?.measurements;
    works.push({
      key: `fng:${o.objectId}`,
      source: 'fng',
      type,
      title: o.title?.en ?? o.title?.fi ?? o.title?.sv,
      artist: p ? [p.firstName, p.familyName].filter(Boolean).join(' ') : null,
      culture: null,
      date: (o.datePrefix ? `${o.datePrefix} ` : '') + span(y0, y1),
      year,
      medium: medium(o.materials),
      department: UNITS[(o.responsibleOrganisation?.split(' / ').pop() ?? '').replace(/, Helsinki$/, '')] ?? null,
      cm: m?.length >= 2 ? [m[1], m[0]] : null,
      web: HOST + img.jpg['1000'],
      print: HOST + (img.jpg['2000'] ?? img.jpg['1000']),
      thumb: HOST + img.jpg['500'],
      download: HOST + (img.jpg['4000'] ?? img.jpg['2000'] ?? img.jpg['1000']),
      url: `https://www.kansallisgalleria.fi/en/object/${o.objectId}`,
    });
  }
  const out = select(works, { key: KEY, cap: 12, keyCap: 50, drawings: 15 });
  console.log(`fng: ${out.length} of ${works.length}`);
  return out;
}
