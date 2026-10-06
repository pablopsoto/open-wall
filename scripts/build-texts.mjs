// Gathers what is written about each work: the museum's own description, its history of
// ownership and exhibitions, and Wikipedia's summary for works famous enough to have one.
// Nothing is invented: a work with no published text simply gets none.
// Usage: npm run texts   (after npm run data)
// Output: public/texts/<shard>.json — loaded only when a work is opened.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { fetchRetry, pool, sleep } from './sources/util.mjs';

const CACHE = new URL('../.cache/', import.meta.url);
const OUT = new URL('../public/texts/', import.meta.url);
export const SHARDS = 64;
const UA = { 'User-Agent': 'OpenWall/1.0 (portfolio project by Pablo Pérez)' };

const { works } = JSON.parse(await readFile(new URL('../src/generated/wall.json', import.meta.url), 'utf8'));
const byKey = new Map(works.map((w) => [w.key, w]));
const texts = new Map(); // key → { about?, aboutSource?, fact?, provenance?, exhibitions? }
const entry = (key) => texts.get(key) ?? texts.set(key, {}).get(key);
const exists = (u) => stat(u).then(() => true, () => false);

/** Plain text: museum fields carry HTML, footnote markers and stray whitespace. */
const clean = (s) =>
  (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/\[\d+\]/g, '')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

// ——— Cleveland: description, a fact, provenance and exhibitions, all CC0 ———
async function cleveland() {
  const ids = works.filter((w) => w.source === 'cma').map((w) => w.key.slice(4));
  const file = new URL('texts-cma.json', CACHE);
  let records;
  if (await exists(file)) records = JSON.parse(await readFile(file, 'utf8'));
  else {
    records = [];
    // The API filters by type and date, not by id lists: walk the same listings the importer used.
    const wanted = new Set(ids.map(Number));
    for (const type of ['Painting', 'Print', 'Drawing']) {
      for (let skip = 0; ; skip += 1000) {
        const page = await fetchRetry(
          `https://openaccess-api.clevelandart.org/api/artworks/?cc0=1&type=${type}&has_image=1&created_after=1860&limit=1000&skip=${skip}&fields=id,description,did_you_know,provenance,exhibitions`,
        );
        records.push(...(page?.data ?? []).filter((a) => wanted.has(a.id)));
        if (!page?.data?.length || skip + page.data.length >= page.info.total) break;
      }
    }
    await writeFile(file, JSON.stringify(records));
  }
  for (const a of records) {
    const key = `cma:${a.id}`;
    if (!byKey.has(key)) continue;
    const t = entry(key);
    if (clean(a.description)) [t.about, t.aboutSource] = [clean(a.description), 'museum'];
    const fact = clean(a.did_you_know);
    if (fact) t.fact = fact;
    const prov = (a.provenance ?? []).map((p) => ({ date: clean(p.date).replace(/^-/, 'until '), text: clean(p.description) })).filter((p) => p.text);
    if (prov.length) t.provenance = prov;
    const shows = [...(a.exhibitions?.current ?? []), ...(a.exhibitions?.legacy ?? [])]
      .map((x) => ({ year: x.opening_date?.slice(0, 4) ?? '', text: clean(x.description || x.title) }))
      .filter((x) => x.text)
      .sort((x, y) => x.year.localeCompare(y.year));
    if (shows.length) t.exhibitions = shows;
  }
  console.log(`cleveland: ${records.length} records`);
}

// ——— National Gallery of Art: provenance and exhibition history from its open data ———
async function nga() {
  const ours = new Set(works.filter((w) => w.source === 'nga').map((w) => w.key.slice(4)));
  const opts = { columns: true, relax_quotes: true, skip_empty_lines: true };
  for (const o of parse(await readFile(new URL('nga-objects.csv', CACHE)), opts)) {
    if (!ours.has(o.objectid) || !clean(o.provenancetext)) continue;
    // The museum separates owners with semicolons. Notes follow the last owner after a full
    // stop; keep the chain, drop the notes (stops after Mr., Dr., M. and the like don't count).
    const parts = clean(o.provenancetext).split(/;\s+/);
    const last = parts.pop() ?? '';
    const end = /(?<!\b(?:Mr|Mrs|Dr|St|Jr|Sr|Co|no|nos|M|[A-Z]))\.\s+(?=[A-Z])/.exec(last);
    parts.push(end ? last.slice(0, end.index) : last);
    const prov = parts
      .map((p) => p.replace(/\.$/, '').trim())
      .filter((p) => p.length > 3)
      // The year of the transaction, not an owner's life dates in brackets.
      .map((text) => ({ date: (/\b(1[5-9]\d\d|20[0-2]\d)\b/.exec(text.replace(/\[[^\]]*\]/g, '')) ?? [''])[0], text }));
    if (prov.length) entry(`nga:${o.objectid}`).provenance = prov;
  }
  const file = new URL('nga-objects_text_entries.csv', CACHE);
  if (!(await exists(file)))
    await writeFile(file, await fetchRetry('https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects_text_entries.csv', 'buffer'));
  for (const t of parse(await readFile(file), opts)) {
    if (t.texttype !== 'exhibition_history' || !ours.has(t.objectid)) continue;
    const e = entry(`nga:${t.objectid}`);
    (e.exhibitions ??= []).push({ year: t.year ?? '', text: clean(t.text) });
  }
  for (const [k, t] of texts) if (k.startsWith('nga:') && t.exhibitions) t.exhibitions.sort((a, b) => a.year.localeCompare(b.year));
  console.log(`nga: ${[...texts.keys()].filter((k) => k.startsWith('nga:')).length} works with history`);
}

// ——— Rijksmuseum: its own English description of each painting, from the Linked Art records ———
async function rijksmuseum() {
  const file = new URL('texts-rkm.json', CACHE);
  let found;
  if (await exists(file)) found = JSON.parse(await readFile(file, 'utf8'));
  else {
    const EN = 'http://vocab.getty.edu/aat/300388277';
    const DESCRIPTION = 'http://vocab.getty.edu/aat/300048722';
    const ids = works.filter((w) => w.source === 'rkm').map((w) => w.key.slice(4));
    found = (
      await pool(ids, 6, async (inv) => {
        const hit = await fetchRetry(`https://data.rijksmuseum.nl/search/collection?objectNumber=${encodeURIComponent(inv)}`).catch(() => null);
        const id = hit?.orderedItems?.[0]?.id;
        const o = id && (await fetchRetry(id, 'json', { headers: { Accept: 'application/ld+json' } }).catch(() => null));
        // Each language's texts are a text of their own; take the English one's description.
        const text = (o?.subject_of ?? [])
          .filter((s) => s.language?.some((l) => l.id === EN))
          .flatMap((s) => s.part ?? [])
          .find((p) => p.classified_as?.some((c) => c.id === DESCRIPTION) && typeof p.content === 'string')?.content;
        return text ? { key: `rkm:${inv}`, text } : null;
      })
    ).filter(Boolean);
    await writeFile(file, JSON.stringify(found));
  }
  for (const f of found) if (byKey.has(f.key)) [entry(f.key).about, entry(f.key).aboutSource] = [clean(f.text), 'museum'];
  console.log(`rijksmuseum: ${found.length} descriptions`);
}

// ——— Wikipedia: the summary of works that have their own article (CC BY-SA) ———
async function wikipedia() {
  const file = new URL('texts-wikipedia.json', CACHE);
  let found;
  if (await exists(file)) found = JSON.parse(await readFile(file, 'utf8'));
  else {
    // Works in our collections that have an English Wikipedia article (two light queries).
    const sparql = async (q) =>
      (await fetchRetry(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, 'json', { headers: UA, signal: AbortSignal.timeout(170000) }))
        .results.bindings;
    const rows = [
      ...(await sparql(`SELECT ?inv ?coll ?article WHERE {
        VALUES ?coll { wd:Q657415 wd:Q671384 wd:Q190804 wd:Q2983474 }
        ?w wdt:P195 ?coll; wdt:P217 ?inv.
        ?article schema:about ?w; schema:isPartOf <https://en.wikipedia.org/>.
      }`)),
      ...(await sparql(`SELECT ?nga ?article WHERE {
        ?w wdt:P4683 ?nga.
        ?article schema:about ?w; schema:isPartOf <https://en.wikipedia.org/>.
      }`)).map((r) => ({ ...r, coll: { value: 'Q214867' } })),
    ];
    const cmaByAccession = new Map(
      works.filter((w) => w.source === 'cma').map((w) => [w.web.split('openaccess-cdn.clevelandart.org/')[1]?.split('/')[0], w.key]),
    );
    // The Finnish National Gallery's works are keyed by object id; Wikidata knows inventory numbers.
    const fngByInventory = new Map();
    if (await exists(new URL('fng-objects.json', CACHE)))
      for (const o of JSON.parse(await readFile(new URL('fng-objects.json', CACHE), 'utf8'))) fngByInventory.set(o.inventoryNumber, `fng:${o.objectId}`);
    const targets = [];
    for (const r of rows) {
      const coll = r.coll.value.split('/').pop();
      const key =
        coll === 'Q214867'
          ? `nga:${r.nga?.value}`
          : coll === 'Q671384'
            ? `smk:${r.inv.value}`
            : coll === 'Q190804'
              ? `rkm:${r.inv.value}`
              : coll === 'Q2983474'
                ? fngByInventory.get(r.inv.value)
                : cmaByAccession.get(r.inv?.value);
      if (key && byKey.has(key)) targets.push({ key, title: decodeURIComponent(r.article.value.split('/wiki/')[1]) });
    }
    found = (
      await pool(targets, 4, async ({ key, title }) => {
        await sleep(120);
        const s = await fetchRetry(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, 'json', { headers: UA }).catch(() => null);
        return s?.extract ? { key, extract: s.extract, url: s.content_urls?.desktop?.page } : null;
      })
    ).filter(Boolean);
    await writeFile(file, JSON.stringify(found));
  }
  for (const f of found) {
    const t = entry(f.key);
    t.wikipedia = { text: clean(f.extract), url: f.url };
  }
  console.log(`wikipedia: ${found.length} summaries`);
}

await cleveland();
await nga();
await rijksmuseum();
await wikipedia();

// ——— Shards: a work's texts live in shard hash(key) % SHARDS ———
await mkdir(OUT, { recursive: true });
for (const f of await readdir(OUT)) await rm(new URL(f, OUT));
const shards = Array.from({ length: SHARDS }, () => ({}));
const shardOf = (key) => createHash('sha1').update(key).digest().readUInt32BE(0) % SHARDS;
for (const [key, t] of texts) if (Object.keys(t).length) shards[shardOf(key)][key] = t;
let total = 0;
for (const [i, s] of shards.entries()) {
  await writeFile(new URL(`${i}.json`, OUT), JSON.stringify(s));
  total += Object.keys(s).length;
}
const count = (f) => [...texts.values()].filter(f).length;
console.log(`texts for ${total} works — about: ${count((t) => t.about)}, wikipedia: ${count((t) => t.wikipedia)}, provenance: ${count((t) => t.provenance)}, exhibitions: ${count((t) => t.exhibitions)}`);
