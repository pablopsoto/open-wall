// Europeana: Europe's aggregator, used for museums whose own APIs are thin or closed.
// Search API with a public demo key; set EUROPEANA_KEY for a personal one.
import { fetchRetry } from './util.mjs';

const KEY = process.env.EUROPEANA_KEY ?? 'api2demo';

/**
 * Every open-licence image record a museum has given Europeana. Not filtered by year
 * there: many records (The Kiss among them) carry their date only as a timespan label.
 */
export async function europeana(provider) {
  const items = [];
  for (let cursor = '*'; cursor; ) {
    const q = new URLSearchParams([
      ['wskey', KEY],
      ['query', '*'],
      ['qf', `DATA_PROVIDER:"${provider}"`],
      ['qf', 'TYPE:IMAGE'],
      ['reusability', 'open'],
      ['rows', '100'],
      ['profile', 'rich'],
      ['cursor', cursor],
    ]);
    const page = await fetchRetry(`https://api.europeana.eu/record/v2/search.json?${q}`);
    items.push(...(page?.items ?? []));
    cursor = page?.items?.length ? page.nextCursor : null;
  }
  return items;
}

/** The year a record was made, from its year field or, failing that, its timespan labels. */
export const yearOf = (i) =>
  Number(i.year?.[0]) || Number((i.edmTimespanLabel ?? []).map((l) => /^\s*(\d{4})\b/.exec(l.def)?.[1]).find(Boolean)) || null;

/** First plain value of a language map, preferring English (links don't count). */
export const lang = (m) =>
  m ? [m.en, m.def, ...Object.values(m)].flatMap((v) => v ?? []).find((v) => !v.startsWith('http')) : undefined;

/** The creator's name: often only a link in the record, with the name on the linked agent. */
export const creator = (i) => lang(i.dcCreatorLangAware) ?? lang(i.edmAgentLabelLangAware) ?? i.edmAgentLabel?.find((l) => l.def)?.def ?? null;

export const LICENCES = {
  'http://creativecommons.org/licenses/by-sa/4.0/': 'CC BY-SA 4.0',
  'http://creativecommons.org/licenses/by/4.0/': 'CC BY 4.0',
};
