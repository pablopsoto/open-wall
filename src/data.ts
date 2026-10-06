import dataUrl from './generated/wall.json?url';

export type Kind = 'Painting' | 'Print' | 'Drawing';
export type SourceId = 'cma' | 'met' | 'nga' | 'smk' | 'blv' | 'rkm' | 'fng' | 'nms';

export interface Work {
  /** "<source>:<museum id>", stable across rebuilds; curation decisions use it. */
  key: string;
  source: SourceId;
  type: Kind;
  title: string;
  artist: string | null;
  culture: string | null;
  date: string;
  year: number;
  medium: string | null;
  department: string | null;
  /** Unframed width and height in centimetres. */
  cm: [number, number] | null;
  /** Width / height. */
  ar: number;
  web: string;
  print: string | null;
  url: string;
  /** The largest image the museum offers, when the importer knows it. */
  download?: string;
  /** Required credit for the photograph, when its licence asks for one. */
  credit?: string;
  palette: string[];
  weights: number[];
  hue: number;
  sat: number;
  lum: number;
  atlas: number;
  /** x, y, w, h in atlas pixels. */
  uv: [number, number, number, number];
}

export interface Atlas {
  file: string;
  width: number;
  height: number;
}

export interface Collection {
  sources: Record<SourceId, { name: string; site: string }>;
  atlases: Atlas[];
  works: Work[];
}

export interface Curation {
  showUnreviewed: boolean;
  yes: string[];
  no: string[];
}

export async function loadCollection(): Promise<Collection> {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error(`collection ${res.status}`);
  return res.json();
}

/** What the curator has put on the wall. Without an answer, everything hangs. */
export async function loadCuration(): Promise<Curation> {
  try {
    const res = await fetch('/api/wall');
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return { showUnreviewed: true, yes: [], no: [] };
  }
}

export function curate(works: Work[], c: Curation) {
  const yes = new Set(c.yes);
  const no = new Set(c.no);
  return works.filter((w) => yes.has(w.key) || (c.showUnreviewed && !no.has(w.key)));
}

/** Images come through our own origin: most museum CDNs don't send CORS headers. */
export const imageUrl = (url: string) => `/img/${url.replace(/^https:\/\//, '')}`;

export const byline = (w: Work) => w.artist ?? w.culture ?? 'Unknown artist';

/** What has been written about a work: by its museum, and by Wikipedia for famous ones. */
export interface WorkText {
  about?: string;
  fact?: string;
  wikipedia?: { text: string; url: string };
  provenance?: { date: string; text: string }[];
  exhibitions?: { year: string; text: string }[];
}

const TEXT_SHARDS = 64;
const shards = new Map<number, Promise<Record<string, WorkText>>>();

/** Texts live in 64 small files (same hash as scripts/build-texts.mjs), fetched on demand. */
export async function loadText(key: string): Promise<WorkText | null> {
  const digest = new DataView(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key)));
  const shard = digest.getUint32(0) % TEXT_SHARDS;
  if (!shards.has(shard)) {
    shards.set(
      shard,
      fetch(`/texts/${shard}.json`).then((r) => (r.ok ? r.json() : {}), () => ({})),
    );
  }
  return (await shards.get(shard)!)[key] ?? null;
}

/**
 * The largest image each museum offers: IIIF servers (NGA, SMK) give the original at
 * full size; Cleveland's biggest JPEG is its print size (the master is a TIFF).
 */
export function downloadUrl(w: Work) {
  const iiif = w.print?.split('/full/')[0];
  const source = w.download ?? (w.source === 'cma' ? (w.print ?? w.web) : iiif ? `${iiif}/full/max/0/default.jpg` : (w.print ?? w.web));
  const name = `${byline(w)} - ${w.title} (${w.date})`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 150).trim();
  return `${imageUrl(source)}?download=${encodeURIComponent(name)}`;
}
