// Nationalmuseum, Stockholm: Zorn, Larsson, Liljefors and the Swedish 1880s. Public domain
// (a few photographs CC BY-SA), harvested through Europeana. https://www.nationalmuseum.se
import { creator, europeana, lang, yearOf, LICENCES } from './europeana.mjs';
import { inWindow, select } from './util.mjs';

const KEY = ['Zorn', 'Carl Larsson', 'Liljefors', 'Josephson', 'Carl Fredrik Hill', 'Eugène Jansson', 'Strindberg', 'Hammershøi', 'Richard Bergh', 'Karl Nordström', 'Nils Kreuger', 'Arosenius', 'John Bauer', 'Hanna Pauli', 'Eva Bonnier', 'Prins Eugen', 'Edelfelt', 'Munch', 'Renoir', 'Monet', 'Manet', 'Degas', 'Cézanne', 'Gauguin', 'Sisley', 'Pissarro'];

export async function nationalmuseum() {
  const works = [];
  for (const i of await europeana('Nationalmuseum Sweden')) {
    const kinds = JSON.stringify(i.dcTypeLangAware ?? '');
    // Paintings only: the rest is sculpture, textiles and portrait miniatures.
    if (!/Målning|Måleri/.test(kinds) || /Miniatyr/.test(kinds)) continue;
    const year = yearOf(i);
    const iiif = /^(https?:\/\/[^ ]+?)\/full\/full\/0\/default\.jpg$/.exec(i.edmIsShownBy?.[0] ?? '')?.[1]?.replace(/^http:/, 'https:');
    if (!iiif || !inWindow('Painting', year)) continue;
    const licence = LICENCES[i.rights?.[0]];
    works.push({
      key: `nms:${iiif.split('/').pop().slice(0, 16)}`,
      source: 'nms',
      type: 'Painting',
      title: lang(i.dcTitleLangAware) ?? i.title?.[0],
      artist: creator(i),
      culture: null,
      date: String(year),
      year,
      medium: null,
      department: null,
      cm: null,
      // The image server tops out at 1000 px, whatever is asked for.
      web: `${iiif}/full/!1000,1000/0/default.jpg`,
      print: null,
      thumb: `${iiif}/full/!400,400/0/default.jpg`,
      download: `${iiif}/full/!1000,1000/0/default.jpg`,
      url: i.edmIsShownAt?.[0]?.replace(/^http:/, 'https:'),
      ...(licence && { credit: `Photo: Nationalmuseum, Stockholm — ${licence}` }),
    });
  }
  const out = select(works, { key: KEY, cap: 10, keyCap: 60 });
  console.log(`nationalmuseum: ${out.length} of ${works.length}`);
  return out;
}
