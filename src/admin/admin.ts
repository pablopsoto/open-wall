// The curator: one work at a time, swipe right to hang it, left to take it down.
import './admin.css';
import { byline, imageUrl, loadCollection, type Collection, type Work } from '../data';
import { esc } from '../ui';

type Verdict = 0 | 1;
interface Filters {
  view: 'swipe' | 'grid';
  queue: 'todo' | 'yes' | 'no' | 'all';
  source: string;
  type: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const loginView = $('login');
const app = $('app');
const deckEl = $('deck');
const gridEl = $('grid');
const preview = $<HTMLDialogElement>('preview');
const statsEl = $('stats');
const toastEl = $('toast');
const unreviewedEl = $<HTMLInputElement>('unreviewed');

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

let toastTimer = 0;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ——— Sign in ———

async function start() {
  const signedIn = await call('/api/me').then(
    () => true,
    () => false,
  );
  if (signedIn) return curate();
  loginView.hidden = false;
  const form = loginView.querySelector('form')!;
  const error = form.querySelector<HTMLElement>('.error')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button')!;
    button.disabled = true;
    try {
      await call('/api/login', { password: new FormData(form).get('password') });
      loginView.hidden = true;
      curate();
    } catch (err) {
      error.textContent = (err as Error).message;
      form.querySelector('input')!.select();
    } finally {
      button.disabled = false;
    }
  });
}

// ——— Curating ———

async function curate() {
  app.hidden = false;
  const [collection, state] = await Promise.all([
    loadCollection(),
    call<{ decisions: { key: string; verdict: Verdict; decided_at: number }[]; showUnreviewed: boolean }>('/api/decisions'),
  ]);
  const works = collection.works;
  const verdicts = new Map<string, Verdict>(state.decisions.map((d) => [d.key, d.verdict]));
  const decidedAt = new Map<string, number>(state.decisions.map((d) => [d.key, d.decided_at]));
  const filters: Filters = { view: 'swipe', queue: 'todo', source: 'all', type: 'all' };
  const history: { key: string; before: Verdict | undefined }[] = [];
  // A stable shuffle, so the queue isn't one museum after another.
  const rank = new Map(works.map((w) => [w.key, hashKey(w.key)]));
  let queue: Work[] = [];
  let pos = 0;

  unreviewedEl.checked = state.showUnreviewed;
  unreviewedEl.addEventListener('change', async () => {
    try {
      await call('/api/settings', { showUnreviewed: unreviewedEl.checked });
      toast(unreviewedEl.checked ? 'Unreviewed works now hang on the wall.' : 'Only works you approved hang on the wall.');
      renderStats();
    } catch (e) {
      unreviewedEl.checked = !unreviewedEl.checked;
      toast((e as Error).message);
    }
  });

  function buildQueue() {
    queue = works
      .filter((w) => filters.source === 'all' || w.source === filters.source)
      .filter((w) => filters.type === 'all' || w.type === filters.type)
      .filter((w) => {
        const v = verdicts.get(w.key);
        return filters.queue === 'all' ? true : filters.queue === 'todo' ? v === undefined : v === (filters.queue === 'yes' ? 1 : 0);
      })
      .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
    // Reviewed lists read best newest-first: what you just decided is at the top.
    if (filters.queue === 'yes' || filters.queue === 'no') queue.sort((a, b) => (decidedAt.get(b.key) ?? 0) - (decidedAt.get(a.key) ?? 0));
    pos = 0;
    app.dataset.view = filters.view;
    deckEl.hidden = filters.view === 'grid';
    gridEl.hidden = filters.view !== 'grid';
    if (filters.view === 'grid') renderGrid();
    else render();
  }

  // ——— The grid: everything in the selection at once, from the wall's own thumbnail sheets ———
  function tile(w: Work) {
    const a = collection.atlases[w.atlas];
    const tileH = innerWidth < 820 ? 88 : 112;
    const s = tileH / w.uv[3];
    const el = document.createElement('figure');
    el.className = 'tile';
    el.dataset.key = w.key;
    el.title = `${w.title} — ${byline(w)}, ${w.date}`;
    el.style.cssText = `width:${Math.round(w.uv[2] * s)}px;height:${tileH}px;background-image:url(${a.file});background-size:${a.width * s}px ${a.height * s}px;background-position:-${w.uv[0] * s}px -${w.uv[1] * s}px`;
    paintTile(el, w);
    return el;
  }
  function paintTile(el: HTMLElement, w: Work) {
    const v = verdicts.get(w.key);
    el.dataset.state = v === undefined ? 'todo' : v ? 'on' : 'off';
    el.innerHTML = `<button type="button" class="quick" aria-label="${v === 0 ? 'Put back on the wall' : 'Take off the wall'}">${v === 0 ? 'Put back' : 'Take off'}</button>`;
  }
  function renderGrid() {
    renderStats();
    if (!queue.length) {
      gridEl.innerHTML = `<div class="empty"><p>Nothing here.</p><span>No works match these filters.</span></div>`;
      return;
    }
    gridEl.dataset.count = `${queue.length.toLocaleString('en')} works`;
    gridEl.replaceChildren(...queue.map(tile));
  }

  /** Record a verdict without the deck: from the grid or the preview. */
  async function setVerdict(w: Work, verdict: Verdict) {
    const before = verdicts.get(w.key);
    if (before === verdict) return;
    verdicts.set(w.key, verdict);
    decidedAt.set(w.key, Date.now());
    history.push({ key: w.key, before });
    refreshTile(w);
    renderStats();
    try {
      await call('/api/decide', { key: w.key, verdict });
      toast(verdict ? 'Back on the wall.' : 'Off the wall.');
    } catch (e) {
      if (before === undefined) verdicts.delete(w.key);
      else verdicts.set(w.key, before);
      history.pop();
      refreshTile(w);
      renderStats();
      toast(`Not saved: ${(e as Error).message}`);
    }
  }
  function refreshTile(w: Work) {
    const el = gridEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(w.key)}"]`);
    if (el) paintTile(el, w);
    if (preview.open && previewing === w) showPreview(w);
  }

  gridEl.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (!el) return;
    const w = queue.find((x) => x.key === el.dataset.key)!;
    if ((e.target as HTMLElement).closest('.quick')) setVerdict(w, verdicts.get(w.key) === 0 ? 1 : 0);
    else showPreview(w);
  });

  // ——— Preview: a closer look before deciding ———
  let previewing: Work | null = null;
  function showPreview(w: Work) {
    previewing = w;
    const v = verdicts.get(w.key);
    const img = preview.querySelector('img')!;
    if (img.dataset.key !== w.key) {
      img.dataset.key = w.key;
      img.removeAttribute('src');
      img.src = imageUrl(w.web);
    }
    preview.style.setProperty('--tint', w.palette[0]);
    preview.querySelector('h2')!.textContent = w.title;
    preview.querySelector('.who')!.textContent = `${byline(w)}, ${w.date}`;
    preview.querySelector('.tags')!.innerHTML = `<span>${esc(collectionName(collection, w))}</span><span>${esc(w.type)}</span>${
      v === undefined ? '<span>Not reviewed</span>' : `<span class="status ${v ? 'on' : 'off'}">${v ? 'On the wall' : 'Off the wall'}</span>`
    }`;
    for (const b of preview.querySelectorAll<HTMLButtonElement>('[data-verdict]')) b.disabled = Number(b.dataset.verdict) === v;
    if (!preview.open) preview.showModal();
  }
  preview.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === preview || t.closest('[data-close]')) return preview.close();
    const b = t.closest<HTMLElement>('[data-verdict], [data-step]');
    if (!b || !previewing) return;
    if (b.dataset.verdict) setVerdict(previewing, Number(b.dataset.verdict) as Verdict);
    else {
      const k = queue.indexOf(previewing) + Number(b.dataset.step);
      if (queue[k]) showPreview(queue[k]);
    }
  });

  function renderStats() {
    let yes = 0;
    let no = 0;
    for (const v of verdicts.values()) v ? yes++ : no++;
    const left = works.length - yes - no;
    const onWall = yes + (unreviewedEl.checked ? left : 0);
    statsEl.innerHTML = `<b>${onWall.toLocaleString('en')}</b> on the wall <span>·</span> ${yes.toLocaleString('en')} approved <span>·</span> ${no.toLocaleString('en')} removed <span>·</span> ${left.toLocaleString('en')} to review`;
  }

  // ——— The deck: the current card on top, two more peeking behind ———
  function card(w: Work, depth: number) {
    const el = document.createElement('article');
    el.className = 'card';
    el.style.setProperty('--depth', String(depth));
    el.style.setProperty('--tint', w.palette[0]);
    const v = verdicts.get(w.key);
    const status = v === undefined ? '' : `<span class="status ${v ? 'on' : 'off'}">${v ? 'On the wall' : 'Off the wall'}</span>`;
    el.innerHTML = `
      <div class="art"><img alt="" draggable="false" /></div>
      <div class="meta">
        <h2>${esc(w.title)}</h2>
        <p class="who">${esc(byline(w))}, ${esc(w.date)}</p>
        <p class="tags"><span>${esc(collectionName(collection, w))}</span><span>${esc(w.type)}</span>${w.medium ? `<span>${esc(w.medium)}</span>` : ''}${status}</p>
      </div>
      <div class="stamp yes">On</div>
      <div class="stamp no">Off</div>`;
    const img = el.querySelector('img')!;
    img.addEventListener('load', () => el.classList.add('loaded'), { once: true });
    img.src = imageUrl(w.web);
    return el;
  }

  function render() {
    renderStats();
    deckEl.replaceChildren();
    const rest = queue.length - pos;
    if (rest <= 0) {
      deckEl.innerHTML = `<div class="empty"><p>Nothing left here.</p><span>${filters.queue === 'todo' ? 'Every work in this selection has been reviewed.' : 'No works match these filters.'}</span></div>`;
      return;
    }
    const shown = queue.slice(pos, pos + 3);
    // Bottom card first, so the top one is last in the DOM.
    for (let k = shown.length - 1; k >= 0; k--) deckEl.append(card(shown[k], k));
    const top = deckEl.lastElementChild as HTMLElement;
    attachSwipe(top, shown[0]);
    // Warm the cache for the cards after these.
    for (const w of queue.slice(pos + 3, pos + 6)) new Image().src = imageUrl(w.web);
    deckEl.dataset.left = `${(rest - 1).toLocaleString('en')} more`;
  }

  async function decide(w: Work, verdict: Verdict | null, el?: HTMLElement) {
    const before = verdicts.get(w.key);
    if (verdict === null) verdicts.delete(w.key);
    else verdicts.set(w.key, verdict);
    if (el) {
      el.classList.add('gone', verdict === 1 ? 'right' : verdict === 0 ? 'left' : 'up');
      await new Promise((r) => setTimeout(r, 260));
    }
    // Reviewing the "to review" queue removes the card from it; other queues just advance.
    pos++;
    if (verdict !== null) history.push({ key: w.key, before });
    render();
    if (verdict === null) return;
    try {
      await call('/api/decide', { key: w.key, verdict });
    } catch (e) {
      if (before === undefined) verdicts.delete(w.key);
      else verdicts.set(w.key, before);
      history.pop();
      toast(`Not saved: ${(e as Error).message}`);
      renderStats();
    }
  }

  async function undo() {
    const last = history.pop();
    if (!last) return toast('Nothing to undo.');
    const w = works.find((x) => x.key === last.key)!;
    if (last.before === undefined) verdicts.delete(last.key);
    else verdicts.set(last.key, last.before);
    // Put the card back on top.
    queue.splice(pos, 0, w);
    render();
    try {
      await call('/api/decide', { key: last.key, verdict: last.before ?? null });
    } catch (e) {
      toast(`Undo not saved: ${(e as Error).message}`);
    }
  }

  function current() {
    return queue[pos];
  }

  // ——— Swipe ———
  function attachSwipe(el: HTMLElement, w: Work) {
    let start: { x: number; y: number; t: number } | null = null;
    let dx = 0;
    let dy = 0;
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('a, button')) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now() };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      dx = e.clientX - start.x;
      dy = e.clientY - start.y;
      el.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${dx * 0.05}deg)`;
      el.style.setProperty('--yes', String(Math.max(0, Math.min(1, dx / 140))));
      el.style.setProperty('--no', String(Math.max(0, Math.min(1, -dx / 140))));
    });
    const end = () => {
      if (!start) return;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - start.t);
      start = null;
      el.classList.remove('dragging');
      if (Math.abs(dx) > 130 || (Math.abs(dx) > 40 && speed > 0.6)) {
        el.style.transform = '';
        decide(w, dx > 0 ? 1 : 0, el);
      } else {
        el.style.transform = '';
        el.style.setProperty('--yes', '0');
        el.style.setProperty('--no', '0');
      }
      dx = dy = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  const topCard = () => deckEl.querySelector<HTMLElement>('.card:last-child') ?? undefined;
  $('yes').addEventListener('click', () => current() && decide(current(), 1, topCard()));
  $('no').addEventListener('click', () => current() && decide(current(), 0, topCard()));
  $('skip').addEventListener('click', () => current() && decide(current(), null, topCard()));
  $('undo').addEventListener('click', undo);
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input') || e.metaKey || e.ctrlKey) return;
    if (preview.open && previewing) {
      const k = queue.indexOf(previewing);
      if (e.key === 'ArrowRight' && queue[k + 1]) showPreview(queue[k + 1]);
      else if (e.key === 'ArrowLeft' && queue[k - 1]) showPreview(queue[k - 1]);
      else return;
      return e.preventDefault();
    }
    if (filters.view === 'grid') return;
    const w = current();
    if (e.key === 'ArrowRight' && w) decide(w, 1, topCard());
    else if (e.key === 'ArrowLeft' && w) decide(w, 0, topCard());
    else if (e.key === 'ArrowUp' && w) decide(w, null, topCard());
    else if (e.key === 'z' || e.key === 'Backspace') undo();
    else return;
    e.preventDefault();
  });

  for (const group of document.querySelectorAll<HTMLElement>('[data-filter]')) {
    group.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      (filters as unknown as Record<string, string>)[group.dataset.filter!] = b.dataset.v!;
      for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      buildQueue();
    });
  }
  $('logout').addEventListener('click', async () => {
    await call('/api/logout', {}).catch(() => {});
    location.reload();
  });

  buildQueue();
}

function hashKey(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const collectionName = (c: Collection, w: Work) => c.sources[w.source]?.name ?? w.source;

start();
