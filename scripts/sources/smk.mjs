// SMK, the National Gallery of Denmark: public-domain works and IIIF images. https://open.smk.dk
import { fetchRetry, inWindow, shuffled } from './util.mjs';

const API = 'https://api.smk.dk/api/v1/art/search/';
const CAPS = { Painting: Infinity, Print: 500, Drawing: 500 };
// Object names as the API gives them with lang=en (Danish ones too, in case).
const TYPE = Object.fromEntries([
  ...['painting', 'maleri'].map((n) => [n, 'Painting']),
  ...['drawing', 'watercolour', 'pastel', 'gouache', 'tegning', 'akvarel'].map((n) => [n, 'Drawing']),
  ...['print', 'lithograph', 'etching', 'xylograph', 'engraving', 'woodcut', 'aquatint', 'monotype', 'copper engraving', 'litografi', 'radering', 'træsnit', 'kobberstik'].map((n) => [n, 'Print']),
]);

export async function smk() {
  const items = [];
  const range = encodeURIComponent('[production_dates_start:{1860-01-01T00:00:00.000Z;1930-12-31T00:00:00.000Z}]');
  const filters = encodeURIComponent('[public_domain:true],[has_image:true]');
  for (let offset = 0; ; offset += 1000) {
    const page = await fetchRetry(`${API}?keys=*&filters=${filters}&range=${range}&offset=${offset}&rows=1000&lang=en`);
    items.push(...(page?.items ?? []));
    if (!page?.items?.length || items.length >= page.found) break;
  }
  const byType = { Painting: [], Print: [], Drawing: [] };
  for (const i of items) {
    const type = (i.object_names ?? []).map((n) => TYPE[n.name?.toLowerCase()]).find(Boolean);
    if (!type || !i.image_iiif_id || !i.image_thumbnail) continue;
    const d = i.production_date?.[0];
    const y0 = d?.start ? Number(d.start.slice(0, 4)) : null;
    const y1 = d?.end ? Number(d.end.slice(0, 4)) : y0;
    const year = y0 == null ? null : Math.round((y0 + y1) / 2);
    if (!inWindow(type, year) || y1 - y0 > 30) continue;
    const p = i.production?.[0];
    const title = (i.titles ?? []).find((t) => t.language === 'engelsk')?.title ?? i.titles?.[0]?.title;
    const dim = (k) => Number(i.dimensions?.find((x) => x.type === k)?.value);
    const h = dim('højde');
    const w = dim('bredde');
    byType[type].push({
      key: `smk:${i.object_number}`,
      source: 'smk',
      type,
      title,
      artist: p ? [p.creator_forename, p.creator_surname].filter(Boolean).join(' ') || p.creator : null,
      culture: p?.creator_nationality ?? null,
      date: d?.period ?? String(year),
      year,
      medium: i.techniques?.[0] ?? null,
      department: null,
      cm: h && w ? [w, h] : null,
      web: i.image_thumbnail,
      print: `${i.image_iiif_id}/full/!2400,2400/0/default.jpg`,
      thumb: i.image_thumbnail.replace('!1024,', '!400,'),
      url: i.frontend_url,
    });
  }
  const out = [];
  for (const [type, list] of Object.entries(byType)) {
    out.push(...shuffled(list).slice(0, CAPS[type]));
    console.log(`smk ${type}: ${Math.min(CAPS[type], list.length)} of ${list.length}`);
  }
  return out;
}
