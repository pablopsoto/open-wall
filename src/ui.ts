import { byline, downloadUrl, loadText, type Collection, type Work, type WorkText } from './data';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const size = (w: Work) => (w.cm ? `${w.cm[1]} × ${w.cm[0]} cm` : null);

/**
 * The wall label for the work in focus. On wide screens it's a column beside the work.
 * On phones it's a bottom sheet: closed, it shows one line (title, artist, year) and the
 * two links; dragged, flicked or tapped open, it covers the work with the whole story.
 */
export function createPanel(
  sources: Collection['sources'],
  o: { onClose: () => void; onStep: (d: number) => void; onColour: (hex: string) => void; onArtist: (name: string) => void },
) {
  const el = document.getElementById('panel')!;
  const body = el.querySelector<HTMLElement>('.panel-body')!;
  const grip = el.querySelector<HTMLButtonElement>('.sheet-grip')!;
  const tools = document.getElementById('panel-tools')!;
  const phone = matchMedia('(max-width: 820px)');
  tools.querySelector('.p-close')!.addEventListener('click', o.onClose);
  tools.querySelector('.p-prev')!.addEventListener('click', () => o.onStep(-1));
  tools.querySelector('.p-next')!.addEventListener('click', () => o.onStep(1));
  body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const sw = t.closest<HTMLElement>('[data-hex]');
    if (sw) o.onColour(sw.dataset.hex!);
    const who = t.closest<HTMLElement>('[data-artist]');
    if (who) o.onArtist(who.dataset.artist!);
    if (t.closest('.p-peek')) setExpanded(!expanded);
  });

  // ——— The sheet (phones only) ———
  let expanded = false;
  function setExpanded(v: boolean) {
    expanded = v && phone.matches;
    el.classList.toggle('expanded', expanded);
    grip.setAttribute('aria-expanded', String(expanded));
    grip.setAttribute('aria-label', expanded ? 'Hide details' : 'Show details');
    if (!expanded) body.scrollTop = 0;
  }
  grip.addEventListener('click', () => setExpanded(!expanded));

  /** How much of the closed sheet shows: the grip, the one-line title and the links. */
  function measurePeek() {
    if (!phone.matches) return 0;
    const links = body.querySelector<HTMLElement>('.p-links');
    const peek = links ? links.offsetTop + links.offsetHeight + 14 : 120;
    el.style.setProperty('--peek', `${peek}px`);
    return peek;
  }
  /** Distance the sheet travels between open and closed. */
  const travel = () => el.offsetHeight - (parseFloat(el.style.getPropertyValue('--peek')) || 120);

  // Dragging uses touch events: the open sheet scrolls natively, and only a pull down from
  // the very top of its content (or anywhere on the closed sheet) moves the sheet itself.
  let drag: { y0: number; base: number; moved: boolean; inContent: boolean; samples: { y: number; t: number }[] } | null = null;
  el.addEventListener(
    'touchstart',
    (e) => {
      if (!phone.matches || e.touches.length > 1 || !el.classList.contains('open')) return;
      const y = e.touches[0].clientY;
      drag = { y0: y, base: expanded ? 0 : travel(), moved: false, inContent: expanded && body.contains(e.target as Node), samples: [{ y, t: e.timeStamp }] };
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!drag) return;
      const y = e.touches[0].clientY;
      const dy = y - drag.y0;
      if (!drag.moved) {
        if (Math.abs(dy) < 6) return;
        // In the open sheet, pulling up or scrolling mid-text is the content's business.
        if (drag.inContent && (dy < 0 || body.scrollTop > 0)) {
          drag = null;
          return;
        }
        drag.moved = true;
        el.classList.add('dragging');
      }
      e.preventDefault();
      const max = travel();
      let pos = drag.base + dy;
      // Resistance past either end: a little stretch, never a hard stop.
      if (pos < 0) pos *= 0.25;
      if (pos > max) pos = max + (pos - max) * 0.45;
      el.style.transform = `translateY(${pos}px)`;
      drag.samples.push({ y, t: e.timeStamp });
      if (drag.samples.length > 6) drag.samples.shift();
    },
    { passive: false },
  );
  const settle = (e: TouchEvent) => {
    const d = drag;
    drag = null;
    if (!d?.moved) return;
    el.classList.remove('dragging');
    // Speed over the last moments of the gesture, not its whole length.
    const last = d.samples.at(-1)!;
    const first = d.samples.find((p) => last.t - p.t <= 120) ?? d.samples[0];
    const velocity = (last.y - first.y) / Math.max(1, last.t - first.t); // px per ms, + is down
    const pos = d.base + (last.y - d.y0);
    const max = travel();
    el.style.transform = '';
    // Pulled well below the closed position: leave the work altogether.
    if (!expanded && pos > max + 90 && velocity >= 0) return o.onClose();
    const moved = pos - d.base;
    // A flick decides by its direction; a deliberate drag only needs to go a little way.
    if (velocity < -0.35) setExpanded(true);
    else if (velocity > 0.35) setExpanded(false);
    else if (!expanded) setExpanded(moved < -56);
    else setExpanded(moved < 80);
    void e;
  };
  el.addEventListener('touchend', settle);
  el.addEventListener('touchcancel', settle);

  let shown = 0;
  /** The written part of the label: description first, then provenance and exhibitions. */
  function story(t: WorkText, museum: string) {
    const about = body.querySelector<HTMLElement>('.p-about')!;
    const history = body.querySelector<HTMLElement>('.p-history')!;
    const parts: string[] = [];
    if (t.about) parts.push(`<p>${esc(t.about)}</p><p class="p-cite">${esc(museum)}</p>`);
    else if (t.wikipedia)
      parts.push(
        `<p>${esc(t.wikipedia.text)}</p><p class="p-cite">From <a href="${esc(t.wikipedia.url)}" target="_blank" rel="noopener">Wikipedia</a>, CC BY-SA</p>`,
      );
    if (t.fact) parts.push(`<p class="p-fact"><span>Did you know</span>${esc(t.fact)}</p>`);
    if (parts.length) {
      about.innerHTML = parts.join('');
      about.hidden = false;
    }
    const list = (items: { when: string; text: string }[]) =>
      `<ol>${items.map((i) => `<li><span>${esc(i.when)}</span>${esc(i.text)}</li>`).join('')}</ol>`;
    const blocks: string[] = [];
    if (t.provenance?.length)
      blocks.push(`<details><summary>History <span>${t.provenance.length} owners and sales</span></summary>${list(t.provenance.map((p) => ({ when: p.date, text: p.text })))}</details>`);
    if (t.exhibitions?.length)
      blocks.push(`<details><summary>Exhibited <span>${t.exhibitions.length} ${t.exhibitions.length === 1 ? 'time' : 'times'}</span></summary>${list(t.exhibitions.map((x) => ({ when: x.year, text: x.text })))}</details>`);
    if (blocks.length) {
      history.innerHTML = blocks.join('');
      history.hidden = false;
    }
  }

  return {
    get expanded() {
      return expanded;
    },
    collapse() {
      setExpanded(false);
    },
    /** Height of the closed sheet on phones (0 on wide screens), for the camera. */
    peek: measurePeek,
    show(w: Work, index: number, total: number) {
      const facts = [
        ['Medium', w.medium],
        ['Size', size(w)],
        ['Culture', w.artist ? w.culture : null],
        ['Museum', sources[w.source].name],
        ['Collection', w.department],
      ].filter(([, v]) => v) as [string, string][];
      const swatches = w.palette
        .map((hex, k) => `<button type="button" data-hex="${hex}" style="--c:${hex};flex:${Math.max(0.12, w.weights[k])}" aria-label="Find paintings in ${hex}"><span>${hex}</span></button>`)
        .join('');
      const html = `
        <div class="p-peek"><p class="p-peek-title">${esc(w.title)}</p><p class="p-peek-by">${esc(byline(w))}, ${esc(w.date)}</p></div>
        <div class="p-head">
          <p class="p-no">${String(index + 1).padStart(4, '0')} <span>/ ${total} — ${esc(w.type)}</span></p>
          <h2>${esc(w.title)}</h2>
          <p class="p-artist"><button type="button" data-artist="${esc(byline(w))}" title="Show only this artist's work">${esc(byline(w))}</button></p>
          <p class="p-date">${esc(w.date)}</p>
        </div>
        <div class="p-about" hidden></div>
        <dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="p-palette-label">Palette — click a colour to find it</div>
        <div class="p-palette">${swatches}</div>
        <div class="p-links">
          <a class="p-source" href="${esc(w.url)}" target="_blank" rel="noopener">View on ${esc(sources[w.source].site)} <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11 11 5M6 5h5v5" /></svg></a>
          <a class="p-download" href="${esc(downloadUrl(w))}" download title="Largest image the museum offers">Download <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg></a>
        </div>
        <div class="p-history" hidden></div>
        <p class="p-licence">Public domain${w.credit ? ` · ${esc(w.credit)}` : ''}</p>`;
      const my = ++shown;
      const swap = () => {
        body.innerHTML = html;
        setExpanded(false);
        el.classList.add('open');
        document.body.classList.add('panel-open');
        measurePeek();
        loadText(w.key).then((t) => my === shown && t && story(t, sources[w.source].name));
      };
      // The cross-fade between works suits the column; the sheet just swaps.
      if (el.classList.contains('open') && !phone.matches && 'startViewTransition' in document) document.startViewTransition(swap);
      else swap();
    },
    hide() {
      setExpanded(false);
      el.classList.remove('open');
      document.body.classList.remove('panel-open');
    },
  };
}

/** Find an artist (to see only their work) or a single work. Type, then Enter. */
export function createSearch(works: Work[], onPick: (i: number) => void, onArtist: (name: string) => void) {
  const dialog = document.getElementById('search') as HTMLDialogElement;
  const input = dialog.querySelector('input')!;
  const list = dialog.querySelector('ol')!;
  const haystack = works.map((w) => `${w.title} ${w.artist ?? ''} ${w.culture ?? ''} ${w.date}`.toLowerCase());
  const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const artists = [...works.reduce((m, w) => m.set(byline(w), (m.get(byline(w)) ?? 0) + 1), new Map<string, number>())]
    .map(([name, count]) => ({ name, count, key: fold(name) }))
    .sort((a, b) => b.count - a.count);
  type Result = { artist: string; count: number } | { work: number };
  let results: Result[] = [];
  let active = 0;

  function render() {
    const terms = fold(input.value).split(/\s+/).filter(Boolean);
    const who: Result[] = terms.length ? artists.filter((a) => terms.every((t) => a.key.includes(t))).slice(0, 4).map((a) => ({ artist: a.name, count: a.count })) : [];
    const what: Result[] = terms.length ? haystack.flatMap((h, i) => (terms.every((t) => fold(h).includes(t)) ? [{ work: i }] : [])).slice(0, 8 - who.length) : [];
    results = [...who, ...what];
    active = 0;
    list.innerHTML = results
      .map((r, k) => {
        if ('artist' in r) {
          return `<li class="artist" data-k="${k}" aria-selected="${k === active}"><i>${esc(r.artist)}</i><span>Artist — show their ${r.count} ${r.count === 1 ? 'work' : 'works'}</span></li>`;
        }
        const w = works[r.work];
        return `<li data-k="${k}" aria-selected="${k === active}"><i>${esc(w.title)}</i><span>${esc(byline(w))} · ${esc(w.date)}</span></li>`;
      })
      .join('');
  }
  function pick(r: Result | undefined) {
    if (!r) return;
    dialog.close();
    if ('artist' in r) onArtist(r.artist);
    else onPick(r.work);
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
      [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
    } else if (e.key === 'Enter') {
      // Otherwise the same Enter lands on whatever button gets focus back.
      e.preventDefault();
      pick(results[active]);
    }
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li');
    if (li) pick(results[Number(li.dataset.k)]);
  });
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());

  return {
    get open() {
      return dialog.open;
    },
    show() {
      input.value = '';
      render();
      dialog.showModal();
      input.focus();
    },
  };
}
