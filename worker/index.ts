// Open Wall's Worker: proxies museum images (most museum CDNs send no CORS headers, and the
// GPU needs them), and keeps the curator's decisions about what hangs on the wall.
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  LOGIN_LIMIT: RateLimit;
  /** Set with `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD: string;
}

// Only these museums' image servers are reachable through /img/<host>/<path>.
const IMAGE_HOSTS = new Set([
  'openaccess-cdn.clevelandart.org',
  'images.metmuseum.org',
  'api.nga.gov',
  'iip.smk.dk',
  'iip-thumb.smk.dk',
  'sammlung.belvedere.at',
  'iiif.micr.io',
  'kokoelma.kansallisgalleria.fi',
  'nationalmuseumse.iiifhosting.com',
]);
const COOKIE = 'ow_session';
const SESSION_DAYS = 30;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

async function image(url: URL): Promise<Response> {
  const rest = url.pathname.slice('/img/'.length);
  const host = rest.slice(0, rest.indexOf('/'));
  if (!IMAGE_HOSTS.has(host)) return new Response(null, { status: 404 });
  const download = url.searchParams.get('download');
  url.searchParams.delete('download');
  const get = (target: string) =>
    fetch(target, {
      // Some museum servers (the Belvedere's) turn away requests that don't say who they are.
      headers: { 'user-agent': 'OpenWall/1.0 (+https://open-wall.pablopsoto.workers.dev)' },
      cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 * 30 },
    });
  let upstream = await get(`https://${rest}${url.search}`);
  // The Belvedere withholds the original of some famous works; its largest web image stands in.
  const belvedere = /^sammlung\.belvedere\.at\/internal\/media\/downloaddispatcher\/(\d+)$/.exec(rest);
  if (!upstream.ok && belvedere) upstream = await get(`https://sammlung.belvedere.at/internal/media/dispatcher/${belvedere[1]}/full`);
  if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
    'cache-control': 'public, max-age=2592000, immutable',
    'access-control-allow-origin': '*',
  });
  const length = upstream.headers.get('content-length');
  if (length) headers.set('content-length', length);
  if (download) {
    // "Artist - Title (Year).jpg": an ASCII fallback, and the real name for browsers that read it.
    const name = `${download.slice(0, 150)}.jpg`;
    const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
    headers.set('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(upstream.body, { headers });
}

// ——— Sessions: "<expiry>.<hmac>", keyed by the password so changing it signs everyone out ———

const enc = new TextEncoder();
async function hmac(env: Env, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`open-wall:${env.ADMIN_PASSWORD}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
}

/** Compare secrets without leaking how much of them matched. */
async function same(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function signedIn(request: Request, env: Env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('cookie') ?? '';
  const value = cookie.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const [expiry, sig] = value.split('.');
  if (!expiry || !sig || Number(expiry) < Date.now()) return false;
  return same(sig, await hmac(env, expiry));
}

function sessionCookie(value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

// ——— The curation API ———

async function wall(env: Env) {
  const [{ results }, setting] = await Promise.all([
    env.DB.prepare('SELECT key, verdict FROM decisions').all<{ key: string; verdict: number }>(),
    env.DB.prepare("SELECT value FROM settings WHERE name = 'showUnreviewed'").first<{ value: string }>(),
  ]);
  return {
    showUnreviewed: setting?.value !== 'false',
    yes: results.filter((r) => r.verdict === 1).map((r) => r.key),
    no: results.filter((r) => r.verdict === 0).map((r) => r.key),
  };
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;

  if (route === 'GET /api/wall') {
    // Public and cheap: the wall reads this on every visit.
    return json(await wall(env), { headers: { 'cache-control': 'public, max-age=20' } });
  }

  if (route === 'POST /api/login') {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
    if (!success) return json({ error: 'Too many attempts. Wait a minute.' }, { status: 429 });
    if (!env.ADMIN_PASSWORD) return json({ error: 'No admin password is set on the server.' }, { status: 503 });
    const { password } = await request.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (typeof password !== 'string' || !(await same(password, env.ADMIN_PASSWORD))) {
      return json({ error: 'Wrong password.' }, { status: 401 });
    }
    const expiry = String(Date.now() + SESSION_DAYS * 864e5);
    return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(`${expiry}.${await hmac(env, expiry)}`, SESSION_DAYS * 86400) } });
  }

  if (route === 'POST /api/logout') return json({ ok: true }, { headers: { 'set-cookie': sessionCookie('', 0) } });

  // Everything below is for the curator only.
  if (!(await signedIn(request, env))) return json({ error: 'Sign in first.' }, { status: 401 });

  if (route === 'GET /api/me') return json({ ok: true });

  if (route === 'GET /api/decisions') {
    const { results } = await env.DB.prepare('SELECT key, verdict, decided_at FROM decisions ORDER BY decided_at DESC').all();
    const w = await wall(env);
    return json({ decisions: results, showUnreviewed: w.showUnreviewed }, { headers: { 'cache-control': 'no-store' } });
  }

  if (route === 'POST /api/decide') {
    const { key, verdict } = await request.json<{ key?: string; verdict?: 0 | 1 | null }>();
    if (typeof key !== 'string' || !/^[a-z]{3}:[\w.\-/]+$/.test(key) || ![0, 1, null].includes(verdict as never)) {
      return json({ error: 'Bad decision.' }, { status: 400 });
    }
    if (verdict === null) await env.DB.prepare('DELETE FROM decisions WHERE key = ?').bind(key).run();
    else
      await env.DB.prepare(
        'INSERT INTO decisions (key, verdict, decided_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET verdict = ?2, decided_at = ?3',
      )
        .bind(key, verdict, Date.now())
        .run();
    return json({ ok: true });
  }

  if (route === 'POST /api/settings') {
    const { showUnreviewed } = await request.json<{ showUnreviewed?: boolean }>();
    if (typeof showUnreviewed !== 'boolean') return json({ error: 'Bad setting.' }, { status: 400 });
    await env.DB.prepare("INSERT INTO settings (name, value) VALUES ('showUnreviewed', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1")
      .bind(String(showUnreviewed))
      .run();
    return json({ ok: true });
  }

  return json({ error: 'Not found.' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/img/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      return image(url);
    }
    if (url.pathname.startsWith('/api/')) {
      // State changes only from our own pages.
      const origin = request.headers.get('origin');
      if (request.method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Forbidden.' }, { status: 403 });
      return api(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
