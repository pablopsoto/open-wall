// Belvedere, Vienna: Klimt, Schiele and Viennese modernism. Photographs CC BY-SA 4.0,
// harvested through Europeana. https://sammlung.belvedere.at
import { creator, europeana, lang, yearOf } from './europeana.mjs';
import { inWindow, select } from './util.mjs';

const KEY = ['Klimt', 'Schiele', 'Kokoschka', 'Gerstl', 'Carl Moll', 'Makart', 'Romako', 'Schindler', 'Tina Blau', 'Corinth', 'Segantini', 'Waldmüller', 'Faistauer', 'Kolig', 'Boeckl', 'Munch', 'Monet', 'Renoir', 'van Gogh', 'Cézanne', 'Manet', 'Degas', 'Liebermann', 'Böcklin', 'Hodler', 'Khnopff', 'Rodin'];

export async function belvedere() {
  const works = [];
  for (const i of await europeana('Austrian Gallery Belvedere')) {
    const kinds = JSON.stringify(i.dcTypeLangAware ?? '');
    const type = /Gemälde|Malerei/.test(kinds) ? 'Painting' : /Skizzenbuch/.test(kinds) ? null : /Zeichnung|Aquarell/.test(kinds) ? 'Drawing' : /Druck/.test(kinds) ? 'Print' : null;
    const year = yearOf(i);
    const id = /dispatcher\/(\d+)/.exec(i.edmIsShownBy?.[0] ?? '')?.[1];
    if (!type || !id || !inWindow(type, year)) continue;
    const media = `https://sammlung.belvedere.at/internal/media/dispatcher/${id}`;
    works.push({
      key: `blv:${id}`,
      source: 'blv',
      type,
      title: lang(i.dcTitleLangAware) ?? i.title?.[0],
      artist: creator(i),
      culture: null,
      date: String(year),
      year,
      medium: null,
      department: null,
      cm: null,
      // ~750 and ~1100 px; the original (downloaddispatcher) is refused for some famous works.
      web: `${media}/preview`,
      print: `${media}/full`,
      thumb: `${media}/thumbnail`,
      download: `https://sammlung.belvedere.at/internal/media/downloaddispatcher/${id}`,
      url: i.edmIsShownAt?.[0],
      credit: 'Photo: Belvedere, Vienna — CC BY-SA 4.0',
    });
  }
  const out = select(works, { key: KEY, cap: 12, keyCap: 80, drawings: 25 });
  console.log(`belvedere: ${out.length} of ${works.length}`);
  return out;
}
