// Rijksmuseum, Amsterdam: the Hague School, Breitner, Israels, Van Gogh. Public domain
// images, CC0 data, as Linked Art. https://data.rijksmuseum.nl
import { fetchRetry, inWindow, pool, select, span } from './util.mjs';

const KEY = ['Gogh', 'Breitner', 'Israëls', 'Israels', 'Mauve', 'Maris', 'Toorop', 'Witsen', 'Mesdag', 'Weissenbruch', 'Mondriaan', 'Mondrian', 'Sluijters', 'Bosboom', 'Suze Robertson', 'Thérèse Schwartze', 'Kever', 'Neuhuys', 'Bauer', 'Monet', 'Alma-Tadema', 'Jongkind', 'Gabriël', 'Roelofs', 'Verster', 'Thorn Prikker'];
const LA = { headers: { Accept: 'application/ld+json' } };
const EN = 'http://vocab.getty.edu/aat/300388277';
const ld = (id) => fetchRetry(id, 'json', LA);

export async function rijksmuseum() {
  // The search API takes one creation year at a time and pages by 'next'.
  const ids = [];
  for (let y = 1860; y <= 1930; y++) {
    for (let url = `https://data.rijksmuseum.nl/search/collection?type=painting&creationDate=${y}&imageAvailable=true`; url; ) {
      const page = await fetchRetry(url);
      ids.push(...(page?.orderedItems ?? []).map((i) => i.id));
      url = page?.next?.id ?? null;
    }
  }
  const works = (
    await pool([...new Set(ids)], 6, async (id) => {
      try {
        const o = await ld(id);
        const names = (o.identified_by ?? []).filter((x) => x.type === 'Name');
        const title = (names.find((n) => n.language?.some((l) => l.id === EN)) ?? names[0])?.content;
        const inv = o.identified_by?.find((x) => x.type === 'Identifier')?.content;
        const t = o.produced_by?.timespan;
        const y0 = Number(t?.begin_of_the_begin?.slice(0, 4));
        const y1 = Number(t?.end_of_the_end?.slice(0, 4)) || y0;
        const year = Math.round((y0 + y1) / 2);
        if (!inWindow('Painting', year) || y1 - y0 > 40) return null;
        const who = o.produced_by?.part?.[0]?.carried_out_by?.[0];
        const artist = who?.notation?.find((n) => n['@language'] === 'en')?.['@value'] ?? null;
        const shown = await ld(o.shows?.[0]?.id);
        const digital = await ld(shown?.digitally_shown_by?.[0]?.id);
        const iiif = digital?.access_point?.[0]?.id?.split('/full/')[0];
        if (!iiif) return null;
        const cm = (k) => Number(o.dimension?.find((d) => d.classified_as?.some((c) => c.notation?.some((n) => n['@value'] === k)) && /cm/.test(JSON.stringify(d.unit ?? '')))?.value);
        const date = t?.identified_by?.find((n) => n.language?.some((l) => l.id === EN))?.content ?? span(y0, y1);
        return {
          key: `rkm:${inv}`,
          source: 'rkm',
          type: 'Painting',
          title,
          artist,
          culture: null,
          date,
          year,
          medium: null,
          department: null,
          cm: cm('width') && cm('height') ? [cm('width'), cm('height')] : null,
          web: `${iiif}/full/!1000,1000/0/default.jpg`,
          print: `${iiif}/full/!2600,2600/0/default.jpg`,
          thumb: `${iiif}/full/!400,400/0/default.jpg`,
          download: `${iiif}/full/max/0/default.jpg`,
          url: `https://www.rijksmuseum.nl/en/collection/${inv}`,
          wikidata: who?.equivalent?.find((e) => e.id.includes('wikidata'))?.id ?? null,
        };
      } catch (e) {
        console.warn(`✗ ${id} ${e.message}`);
        return null;
      }
    })
  ).filter((w) => w?.title && w.key !== 'rkm:undefined');
  const out = select(works, { key: KEY, cap: 10, keyCap: 50 });
  console.log(`rijksmuseum: ${out.length} of ${works.length} (from ${new Set(ids).size} found)`);
  return out.map(({ wikidata: _w, ...w }) => w);
}
