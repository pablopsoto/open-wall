// National Gallery of Art, Washington: open data (CC0) and open-access IIIF images.
// https://github.com/NationalGalleryOfArt/opendata
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { fetchRetry, inWindow, parseCm, shuffled } from './util.mjs';

const RAW = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/';
const CAPS = { Painting: Infinity, Print: 900, Drawing: 500 };

async function csv(name) {
  const file = new URL(`../../.cache/nga-${name}`, import.meta.url);
  if (!(await stat(file).catch(() => null))) await writeFile(file, await fetchRetry(RAW + name, 'buffer'));
  return parse(await readFile(file), { columns: true, relax_quotes: true, skip_empty_lines: true });
}

export async function nga() {
  const [objects, images] = await Promise.all([csv('objects.csv'), csv('published_images.csv')]);
  const image = new Map();
  for (const i of images) if (i.openaccess === '1' && i.viewtype === 'primary') image.set(i.depictstmsobjectid, i);
  const byType = { Painting: [], Print: [], Drawing: [] };
  for (const o of objects) {
    const type = o.classification;
    const img = image.get(o.objectid);
    if (!byType[type] || !img) continue;
    const year = Math.round((Number(o.beginyear) + Number(o.endyear || o.beginyear)) / 2);
    if (!o.beginyear || !inWindow(type, year)) continue;
    const iiif = img.iiifurl;
    byType[type].push({
      key: `nga:${o.objectid}`,
      source: 'nga',
      type,
      title: o.title,
      artist: o.attribution || null,
      culture: null,
      date: o.displaydate,
      year,
      medium: o.medium || null,
      department: null,
      cm: parseCm(o.dimensions),
      web: `${iiif}/full/!1000,1000/0/default.jpg`,
      print: `${iiif}/full/!2600,2600/0/default.jpg`,
      thumb: `${iiif}/full/!400,400/0/default.jpg`,
      url: `https://www.nga.gov/collection/art-object-page.${o.objectid}.html`,
    });
  }
  const out = [];
  for (const [type, list] of Object.entries(byType)) {
    out.push(...shuffled(list).slice(0, CAPS[type]));
    console.log(`nga ${type}: ${Math.min(CAPS[type], list.length)} of ${list.length}`);
  }
  return out;
}
