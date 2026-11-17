// Browse: large title, category chips, filter sheet, virtualized grid.
import { type AppCtx, type View } from '../ctx';
import {
  ADDED, FACETS, SORTS, activeFilterCount, applyFilters, facetCounts, filtersFromParams,
  filtersToParams,
} from '../data';
import { el, icon } from '../dom';
import { VirtualGrid } from '../grid';
import type { FacetKey, Filters, Item, Sort } from '../types';

export function browseView(ctx: AppCtx, params: URLSearchParams): View {
  const { idx } = ctx;
  const f: Filters = filtersFromParams(params);
  let ranked: string[] | null = null;
  let searchSeq = 0;
  const openSections = new Set<string>(['style']);

  // Skeleton --------------------------------------------------------------------------------------
  const title = el('h1');
  const count = el('p', { class: 'title-sub', 'aria-live': 'polite' });
  const clearSearch = el('button', { class: 'pill secondary sm', type: 'button', hidden: true, onclick: () => { f.q = ''; ranked = null; update(); } }, icon('close', 14), 'Clear search');
  const groupSeg = el('div', { class: 'seg seg-page', role: 'group', 'aria-label': 'Groups' });
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Categories' });
  const activeChips = el('div', { class: 'active-chips' });
  const filterBtn = el('button', { class: 'pill secondary sm', type: 'button', 'aria-controls': 'filter-sheet', 'aria-expanded': 'false', onclick: () => toggleSheet(true) },
    icon('sliders', 16), 'Filters', el('span', { class: 'count-dot', hidden: true }));
  const sortSel = el('select', { class: 'select', id: 'sort', 'aria-label': 'Sort by' }, SORTS.map((s) => el('option', { value: s.value }, s.label)));
  sortSel.addEventListener('change', () => { f.sort = sortSel.value as Sort; update(); });

  const facetsEl = el('div', { class: 'facets' });
  const showBtn = el('button', { class: 'pill primary block', type: 'button', onclick: () => toggleSheet(false) });
  const sheet = el('aside', { class: 'filter-sheet glass-strong', id: 'filter-sheet', 'aria-label': 'Filters' },
    el('div', { class: 'fs-head' }, el('h2', {}, 'Filters'),
      el('button', { class: 'link', type: 'button', onclick: () => clearFilters() }, 'Reset'),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close filters', onclick: () => toggleSheet(false) }, icon('close', 18))),
    facetsEl, el('div', { class: 'fs-foot' }, showBtn));
  const scrim = el('div', { class: 'fs-scrim', onclick: () => toggleSheet(false) });

  const gridRoot = el('div', { class: 'grid', role: 'list' });
  const empty = el('div', { class: 'empty', hidden: true });
  const grid = new VirtualGrid(gridRoot, ctx);

  const root = el('div', { class: 'view wrap browse' },
    el('header', { class: 'big-title' }, el('div', {}, title, count), clearSearch),
    groupSeg,
    chips,
    el('div', { class: 'toolbar' }, filterBtn, activeChips, el('label', { class: 'sort', for: 'sort' }, el('span', {}, 'Sort'), sortSel)),
    empty, gridRoot);
  // The sheet lives on <body> so page transitions cannot trap it under the navigation.
  document.body.append(scrim, sheet);

  function toggleSheet(open: boolean): void {
    document.body.classList.toggle('sheet-open', open);
    document.body.classList.toggle('lock', open);
    filterBtn.setAttribute('aria-expanded', String(open));
  }

  // Data ---------------------------------------------------------------------------------------------
  const base = (): Item[] => (ranked ? ranked.map((id) => idx.byId.get(id)!).filter(Boolean) : idx.items);

  async function runSearch(): Promise<void> {
    const q = f.q.trim();
    if (!q) { ranked = null; update(); return; }
    const seq = ++searchSeq;
    count.textContent = 'Searching…';
    const ids = await ctx.search.search(q);
    if (seq !== searchSeq) return;
    ranked = ids;
    update();
  }

  function clearFilters(): void {
    for (const d of FACETS) if (d.key !== 'cat') f.facets[d.key].clear();
    f.added = '';
    f.thumb = false;
    update();
  }

  // Rendering ------------------------------------------------------------------------------------------
  function heading(): string {
    if (f.q.trim()) return `“${f.q.trim()}”`;
    if (f.facets.cat.size === 1) return [...f.facets.cat][0];
    if (f.facets.style.size === 1 && !f.group) return `${[...f.facets.style][0]}`;
    if (f.group) return f.group;
    if (f.added === '7d') return 'New this week';
    return 'All Models';
  }

  function renderGroups(): void {
    const counts = facetCounts(base(), f, 'group');
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const btn = (g: string, label: string, n: number) => el('button', {
      type: 'button', 'aria-pressed': String(f.group === g),
      onclick: () => {
        f.group = g;
        for (const c of [...f.facets.cat]) if (g && idx.categories.get(c)?.group !== g) f.facets.cat.delete(c);
        update();
      },
    }, label, el('span', { class: 'seg-count' }, n.toLocaleString('en')));
    groupSeg.replaceChildren(btn('', 'All', total), ...idx.groups.filter((g) => counts.get(g) || f.group === g).map((g) => btn(g, g, counts.get(g) ?? 0)));
  }

  function renderCategoryChips(): void {
    const counts = facetCounts(base(), f, 'cat');
    const groups = f.group ? [f.group] : idx.groups;
    const names = groups.flatMap((g) => (idx.categoriesByGroup.get(g) ?? []).map((c) => c.name))
      .filter((n) => (counts.get(n) ?? 0) > 0 || f.facets.cat.has(n));
    const all = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.facets.cat.size === 0), onclick: () => { f.facets.cat.clear(); update(); } }, 'All');
    chips.replaceChildren(all, ...names.map((n) => el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(f.facets.cat.has(n)),
      onclick: () => {
        if (f.facets.cat.has(n)) f.facets.cat.delete(n);
        else { f.facets.cat.clear(); f.facets.cat.add(n); }
        update();
      },
    }, n, el('span', {}, (counts.get(n) ?? 0).toLocaleString('en')))));
  }

  const label = (key: FacetKey, v: string) => (key === 'channel' ? idx.channelName.get(v) ?? v : v);

  function option(key: FacetKey, value: string, n: number): HTMLElement {
    const sel = f.facets[key];
    const id = `f-${key}-${value}`.replace(/[^\w-]/g, '_');
    const box = el('input', { type: 'checkbox', id, checked: sel.has(value) });
    box.addEventListener('change', () => { if (box.checked) sel.add(value); else sel.delete(value); update(); });
    return el('label', { class: `opt${n === 0 && !sel.has(value) ? ' zero' : ''}`, for: id },
      el('span', { class: 'opt-label' }, label(key, value)), el('span', { class: 'opt-count' }, n.toLocaleString('en')), box, el('span', { class: 'switch', 'aria-hidden': 'true' }));
  }

  function section(id: string, name: string, active: number, body: Node[]): HTMLElement {
    const d = el('details', { class: 'facet', open: openSections.has(id) },
      el('summary', {}, el('span', {}, name), active ? el('span', { class: 'facet-active' }, String(active)) : null, icon('chevron', 16)),
      el('div', { class: 'group-list' }, body));
    d.addEventListener('toggle', () => { if (d.open) openSections.add(id); else openSections.delete(id); });
    return d;
  }

  function ordered(key: FacetKey, counts: Map<string, number>): string[] {
    const present = [...new Set([...counts.keys(), ...f.facets[key]])];
    const tax = idx.lib.taxonomy;
    if (key === 'version') return present.sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : b.localeCompare(a)));
    if (key === 'channel') return present.sort((a, b) => label(key, a).localeCompare(label(key, b)));
    const order = key === 'style' ? tax.styles : tax.render_engines;
    return present.sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  function renderFacets(): void {
    const nodes: Node[] = [];
    for (const def of FACETS) {
      if (def.key === 'cat') continue; // categories are the chips row
      const counts = facetCounts(base(), f, def.key);
      const values = ordered(def.key, counts).filter((v) => (counts.get(v) ?? 0) > 0 || f.facets[def.key].has(v));
      if (!values.length) continue;
      nodes.push(section(def.key, def.label, f.facets[def.key].size, values.map((v) => option(def.key, v, counts.get(v) ?? 0))));
    }
    const radios = ADDED.map((a) => {
      const id = `added-${a.value || 'any'}`;
      const r = el('input', { type: 'radio', name: 'added', id, checked: f.added === a.value });
      r.addEventListener('change', () => { f.added = a.value; update(); });
      return el('label', { class: 'opt radio', for: id }, el('span', { class: 'opt-label' }, a.label), r, el('span', { class: 'tick', 'aria-hidden': 'true' }, icon('check', 16)));
    });
    nodes.push(section('added', 'Date added', f.added ? 1 : 0, radios));
    const thumb = el('input', { type: 'checkbox', id: 'only-preview', checked: f.thumb });
    thumb.addEventListener('change', () => { f.thumb = thumb.checked; update(); });
    nodes.push(el('div', { class: 'group-list solo' }, el('label', { class: 'opt', for: 'only-preview' },
      el('span', { class: 'opt-label' }, 'Only with preview image'), thumb, el('span', { class: 'switch', 'aria-hidden': 'true' }))));
    facetsEl.replaceChildren(...nodes);
  }

  function renderActive(): void {
    const list: HTMLElement[] = [];
    const chip = (text: string, remove: () => void) => list.push(
      el('button', { class: 'chip active', type: 'button', 'aria-label': `Remove filter ${text}`, onclick: () => { remove(); update(); } }, text, icon('close', 13)));
    for (const def of FACETS) {
      if (def.key === 'cat') continue;
      for (const v of f.facets[def.key]) chip(label(def.key, v), () => f.facets[def.key].delete(v));
    }
    if (f.added) chip(ADDED.find((a) => a.value === f.added)!.label, () => { f.added = ''; });
    if (f.thumb) chip('With preview', () => { f.thumb = false; });
    activeChips.replaceChildren(...list);
  }

  function update(): void {
    const results = applyFilters(base(), f, ranked !== null);
    grid.setItems(results);
    title.textContent = heading();
    const n = results.length;
    count.textContent = `${n.toLocaleString('en')} ${n === 1 ? 'model' : 'models'}`;
    clearSearch.hidden = !f.q.trim();
    showBtn.textContent = `Show ${n.toLocaleString('en')} ${n === 1 ? 'model' : 'models'}`;
    const active = activeFilterCount(f) - f.facets.cat.size;
    const dot = filterBtn.querySelector<HTMLElement>('.count-dot')!;
    dot.hidden = !active;
    dot.textContent = String(active);
    sortSel.querySelector<HTMLOptionElement>('option[value="relevance"]')!.disabled = !f.q.trim();
    sortSel.value = !f.q.trim() && f.sort === 'relevance' ? 'new' : f.sort;
    if (n === 0) {
      empty.replaceChildren(el('b', {}, 'No models found'),
        el('p', {}, f.q ? `Nothing matches “${f.q}” with these filters.` : 'No models match these filters.'),
        el('div', { class: 'cta center' },
          active ? el('button', { class: 'pill primary sm', type: 'button', onclick: clearFilters }, 'Reset filters') : null,
          f.group || f.facets.cat.size ? el('button', { class: 'pill secondary sm', type: 'button', onclick: () => { f.group = ''; f.facets.cat.clear(); update(); } }, 'Search everything') : null));
    }
    empty.hidden = n !== 0;
    renderGroups();
    renderCategoryChips();
    renderFacets();
    renderActive();
    const qs = filtersToParams(f).toString();
    ctx.replace(`#/browse${qs ? `?${qs}` : ''}`);
  }

  if (f.q.trim()) void runSearch(); else update();

  return {
    el: root,
    destroy: () => { grid.destroy(); scrim.remove(); sheet.remove(); document.body.classList.remove('lock', 'sheet-open'); },
    setQuery: (q: string) => {
      if (q === f.q) return;
      f.q = q;
      void runSearch();
    },
  };
}
