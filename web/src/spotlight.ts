// Spotlight-style search: top hit with preview, models, categories, tags, then "search all".
import { metaLine, preview } from './cards';
import { browseHref, type AppCtx } from './ctx';
import { suggest } from './data';
import { debounce, el, icon } from './dom';
import type { Item } from './types';

interface Hit { node: HTMLElement; run: () => void }

export function createSpotlight(getCtx: () => AppCtx): { open: (q?: string) => void; close: () => void; isOpen: () => boolean } {
  const input = el('input', {
    id: 'spot-input', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Search models, categories, tags', 'aria-label': 'Search', 'aria-controls': 'spot-res',
  });
  const results = el('div', { class: 'spot-res', id: 'spot-res', role: 'listbox' });
  const panel = el('div', { class: 'spot glass', role: 'dialog', 'aria-label': 'Search' },
    el('div', { class: 'spot-in' }, icon('search', 22), input,
      el('button', { class: 'icon-btn spot-close', type: 'button', 'aria-label': 'Close search', onclick: () => close() }, icon('close', 18))),
    results);
  const wrap = el('div', { class: 'spot-wrap', hidden: true }, panel);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);

  let hits: Hit[] = [];
  let sel = 0;
  let seq = 0;

  function select(i: number): void {
    sel = Math.max(0, Math.min(hits.length - 1, i));
    hits.forEach((h, k) => h.node.setAttribute('aria-selected', String(k === sel)));
    hits[sel]?.node.scrollIntoView({ block: 'nearest' });
  }

  function hitButton(cls: string, kids: (Node | string)[], run: () => void): Hit {
    const node = el('button', { class: `hit ${cls}`, type: 'button', role: 'option', 'aria-selected': 'false' }, ...kids);
    const hit = { node, run };
    node.addEventListener('click', run);
    node.addEventListener('mousemove', () => select(hits.indexOf(hit)));
    return hit;
  }

  function modelHit(ctx: AppCtx, it: Item, top: boolean): Hit {
    return hitButton(top ? 'top-hit' : '', [
      preview(it, ctx, 'pv th'),
      el('span', { class: 'hit-text' }, el('b', {}, it.t), el('small', {}, top ? `${it.c} · ${metaLine(it)}` : it.c)),
    ], () => { close(); ctx.open(it); });
  }

  async function run(): Promise<void> {
    const ctx = getCtx();
    const raw = input.value.trim();
    const mySeq = ++seq;
    const nodes: Node[] = [];
    hits = [];
    const add = (title: string, list: Hit[]) => {
      if (!list.length) return;
      nodes.push(el('h6', {}, title));
      for (const h of list) { hits.push(h); nodes.push(h.node); }
    };

    if (!raw) {
      add('Recently added', ctx.idx.items.filter((i) => i.th).slice(0, 5).map((it) => modelHit(ctx, it, false)));
      const cats = [...ctx.idx.categories.values()].sort((a, b) => b.count - a.count).slice(0, 4);
      add('Popular categories', cats.map((c) => hitButton('', [el('span', { class: 'ic' }, icon('grid', 17)),
        el('span', { class: 'hit-text' }, el('b', {}, c.name)), el('small', { class: 'hit-count' }, c.count.toLocaleString('en'))],
      () => { close(); ctx.go(browseHref({ g: c.group, cat: c.name })); })));
    } else {
      const ids = await ctx.search.search(raw);
      if (mySeq !== seq) return;
      const models = ids.slice(0, 6).map((id) => ctx.idx.byId.get(id)).filter((i): i is Item => !!i);
      if (models.length) {
        add('Top hit', [modelHit(ctx, models[0], true)]);
        add('Models', models.slice(1).map((it) => modelHit(ctx, it, false)));
      }
      const sugg = suggest(ctx.idx, raw);
      add('Categories', sugg.filter((s) => s.kind === 'category').map((s) => hitButton('', [el('span', { class: 'ic' }, icon('grid', 17)),
        el('span', { class: 'hit-text' }, el('b', {}, s.label), el('small', {}, s.kind === 'category' ? s.group : '')),
        el('small', { class: 'hit-count' }, s.kind === 'category' ? s.count.toLocaleString('en') : '')],
      () => { close(); if (s.kind === 'category') ctx.go(browseHref({ g: s.group, cat: s.label })); })));
      add('Styles and tags', sugg.filter((s) => s.kind === 'style' || s.kind === 'tag').map((s) => hitButton('', [
        el('span', { class: 'ic' }, icon(s.kind === 'style' ? 'layers' : 'tag', 17)),
        el('span', { class: 'hit-text' }, el('b', {}, s.label), el('small', {}, s.kind === 'style' ? 'Style' : 'Tag')),
        el('small', { class: 'hit-count' }, 'count' in s ? s.count.toLocaleString('en') : '')],
      () => { close(); ctx.go(s.kind === 'style' ? browseHref({ style: s.label }) : browseHref({ q: s.label })); })));
      add('Search', [hitButton('', [el('span', { class: 'ic' }, icon('search', 17)),
        el('span', { class: 'hit-text' }, el('b', {}, `Show all results for “${raw}”`), el('small', {}, `${ids.length.toLocaleString('en')} models`))],
      () => { close(); ctx.go(browseHref({ q: raw })); })]);
    }
    if (!hits.length) nodes.push(el('p', { class: 'spot-empty' }, 'No matches. Try a different word.'));
    results.replaceChildren(...nodes);
    select(0);
  }

  const runSoon = debounce(() => { void run(); }, 90);
  input.addEventListener('input', runSoon);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); hits[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  function open(q = ''): void {
    const wasOpen = !wrap.hidden;
    wrap.hidden = false;
    if (!wasOpen) input.value = q;
    input.focus();
    requestAnimationFrame(() => wrap.classList.add('on'));
    document.body.classList.add('lock');
    void run();
  }
  function close(): void {
    wrap.classList.remove('on');
    document.body.classList.remove('lock');
    setTimeout(() => { if (!wrap.classList.contains('on')) wrap.hidden = true; }, 260);
  }
  return { open, close, isOpen: () => !wrap.hidden };
}
