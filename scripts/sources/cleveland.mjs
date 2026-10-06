// Cleveland Museum of Art Open Access (CC0). https://openaccess-api.clevelandart.org
import { fetchRetry, inWindow, shuffled } from './util.mjs';

const API = 'https://openaccess-api.clevelandart.org/api/artworks/';
const TYPES = { Painting: Infinity, Print: 1600, Drawing: 470 };

export async function cleveland() {
  const out = [];
  for (const [type, cap] of Object.entries(TYPES)) {
    const raw = [];
    for (let skip = 0; ; skip += 1000) {
      const page = await fetchRetry(`${API}?cc0=1&type=${type}&has_image=1&created_after=1860&limit=1000&skip=${skip}`);
      raw.push(...page.data);
      if (skip + page.data.length >= page.info.total || !page.data.length) break;
    }
    const works = raw
      .map((a) => {
        const y0 = a.creation_date_earliest;
        const year = y0 == null ? null : Math.round((y0 + (a.creation_date_latest ?? y0)) / 2);
        const dims = a.dimensions?.unframed ?? a.dimensions?.framed;
        return {
          key: `cma:${a.id}`,
          source: 'cma',
          type,
          title: a.title,
          artist: a.creators?.[0]?.description?.replace(/\s*\(.*$/s, '').trim() || null,
          culture: a.culture?.[0] ?? null,
          date: a.creation_date,
          year,
          medium: a.technique,
          department: a.department,
          cm: dims?.height && dims?.width ? [Math.round(dims.width * 1000) / 10, Math.round(dims.height * 1000) / 10] : null,
          web: a.images?.web?.url,
          print: a.images?.print?.url ?? null,
          thumb: a.images?.web?.url,
          url: a.url,
        };
      })
      .filter((w) => w.web && w.title && inWindow(type, w.year));
    out.push(...shuffled(works).slice(0, cap));
    console.log(`cleveland ${type}: ${Math.min(cap, works.length)} of ${works.length}`);
  }
  return out;
}
