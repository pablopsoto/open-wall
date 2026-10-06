// The Metropolitan Museum of Art Open Access (CC0). https://metmuseum.github.io
import { fetchRetry, inWindow, parseCm, pool, shuffled, sleep } from './util.mjs';

const API = 'https://collectionapi.metmuseum.org/public/collection';
// [department, medium filter, our type, how many to keep]
const QUERIES = [
  [11, 'Paintings', 'Painting', Infinity], // European Paintings
  [1, 'Paintings', 'Painting', Infinity], // The American Wing
  [21, 'Paintings', 'Painting', Infinity], // Modern and Contemporary Art
  [9, 'Prints', 'Print', 900], // Drawings and Prints
  [9, 'Drawings', 'Drawing', 500],
];
const TYPE = { Paintings: 'Painting', Prints: 'Print', Drawings: 'Drawing' };

async function ids(dept, medium) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const q = `${API}/v1.1/search?departmentId=${dept}&medium=${medium}&hasImages=true&isPublicDomain=true&dateBegin=1860&dateEnd=1930&q=*&offset=${offset}&limit=1000`;
    const page = await fetchRetry(q);
    all.push(...(page?.objectIDs ?? []));
    if (!page?.objectIDs?.length || all.length >= page.total) break;
  }
  return all;
}

export async function met() {
  const out = [];
  const seen = new Set();
  for (const [dept, medium, type, cap] of QUERIES) {
    const list = shuffled(await ids(dept, medium)).filter((id) => !seen.has(id));
    // Over-fetch a little: some objects turn out to lack an image or a date in range.
    const candidates = cap === Infinity ? list : list.slice(0, Math.ceil(cap * 1.6));
    // Gently: the Met allows 80 requests a second, but its bot protection trips well before.
    let blocked = 0;
    const objects = await pool(candidates, 2, async (id) => {
      await sleep(180);
      if (blocked > 20) throw new Error('The Met is blocking requests; try again later.');
      return fetchRetry(`${API}/v1/objects/${id}`).catch(() => {
        blocked++;
        return null;
      });
    });
    const works = objects
      .filter((o) => o?.isPublicDomain && o.primaryImageSmall && TYPE[o.classification] === type)
      .map((o) => ({
        key: `met:${o.objectID}`,
        source: 'met',
        type,
        title: o.title,
        artist: o.artistDisplayName || null,
        culture: o.artistNationality || o.culture || null,
        date: o.objectDate,
        year: Math.round((o.objectBeginDate + o.objectEndDate) / 2),
        medium: o.medium || null,
        department: o.department,
        cm: parseCm(o.dimensions),
        web: o.primaryImageSmall,
        print: o.primaryImage || null,
        thumb: o.primaryImageSmall,
        url: o.objectURL,
      }))
      .filter((w) => w.title && inWindow(type, w.year))
      .slice(0, cap);
    works.forEach((w) => seen.add(Number(w.key.slice(4))));
    out.push(...works);
    console.log(`met ${dept} ${medium}: ${works.length} of ${list.length}`);
  }
  return out;
}
