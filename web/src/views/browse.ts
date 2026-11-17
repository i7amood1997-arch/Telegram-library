// Browse: group tabs, filter panel (sidebar on desktop, sheet on phones), results grid.
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
  const openSections = new Set<string>(['cat']);

  // Skeleton --------------------------------------------------------------------------------------
  const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  const title = el('h1', { class: 'browse-title' });
  const count = el('p', { class: 'browse-count', 'aria-live': 'polite' });
  const groupTabs = el('div', { class: 'tabs tabs-scroll', role: 'tablist', 'aria-label': 'Groups' });
  const facetsEl = el('div', { class: 'facets' });
  const showBtn = el('button', { class: 'btn btn-primary btn-block sheet-apply', type: 'button', onclick: () => toggleSheet(false) });
  const panel = el('aside', { class: 'filters', id: 'filter-panel', 'aria-label': 'Filters' },
    el('div', { class: 'filters-head' }, el('h2', {}, 'Filters'),
      el('button', { class: 'link-btn clear-all', type: 'button', onclick: () => { clearFilters(); } }, 'Clear all'),
      el('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close filters', onclick: () => toggleSheet(false) }, icon('close'))),
    facetsEl,
    showBtn);
  const scrim = el('div', { class: 'sheet-scrim', onclick: () => toggleSheet(false) });
  const filterBtn = el('button', { class: 'btn btn-ghost filter-btn', type: 'button', 'aria-controls': 'filter-panel', 'aria-expanded': 'false', onclick: () => toggleSheet(true) },
    icon('filter', 16), 'Filters', el('span', { class: 'count-dot', hidden: true }));
  const sortSel = el('select', { class: 'select', id: 'sort', 'aria-label': 'Sort by' },
    SORTS.map((s) => el('option', { value: s.value }, s.label)));
  sortSel.addEventListener('change', () => { f.sort = sortSel.value as Sort; update(); });
  const chips = el('div', { class: 'chips' });
  const gridRoot = el('div', { class: 'grid', role: 'list' });
  const empty = el('div', { class: 'empty', hidden: true });
  const grid = new VirtualGrid(gridRoot, ctx);

  const root = el('div', { class: 'page browse' },
    el('header', { class: 'browse-head' }, crumbs, el('div', { class: 'title-row' }, title, count)),
    groupTabs,
    el('div', { class: 'browse-body' },
      panel,
      scrim,
      el('div', { class: 'results' },
        el('div', { class: 'toolbar' }, filterBtn, chips, el('label', { class: 'sort', for: 'sort' }, el('span', {}, 'Sort'), sortSel)),
        empty,
        gridRoot)));

  function toggleSheet(open: boolean): void {
    root.classList.toggle('sheet-open', open);
    document.body.classList.toggle('no-scroll', open);
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
    for (const d of FACETS) f.facets[d.key].clear();
    f.added = '';
    f.thumb = false;
    update();
  }

  // Rendering ------------------------------------------------------------------------------------------
  function heading(): string {
    if (f.q.trim()) return `Results for “${f.q.trim()}”`;
    const cats = f.facets.cat;
    if (cats.size === 1) return [...cats][0];
    if (f.facets.style.size === 1 && !f.group) return `${[...f.facets.style][0]} style`;
    if (f.group) return f.group;
    if (f.added === '7d') return 'New this week';
    if (f.added === '1d') return 'Added today';
    return 'All models';
  }

  function renderCrumbs(): void {
    const parts: HTMLElement[] = [el('a', { href: '#/' }, 'Home')];
    if (f.group) parts.push(el('a', { href: `#/browse?g=${encodeURIComponent(f.group)}` }, f.group));
    if (f.facets.cat.size === 1) parts.push(el('span', {}, [...f.facets.cat][0]));
    crumbs.replaceChildren(...parts.flatMap((p, i) => (i ? [el('span', { class: 'sep' }, '/'), p] : [p])));
  }

  function renderGroupTabs(): void {
    const counts = facetCounts(base(), f, 'group');
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const tab = (g: string, label: string, n: number) => {
      const b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(f.group === g) },
        label, el('span', { class: 'tab-count' }, n.toLocaleString('en')));
      b.addEventListener('click', () => {
        f.group = g;
        // Categories from another group no longer apply.
        for (const c of [...f.facets.cat]) if (g && idx.categories.get(c)?.group !== g) f.facets.cat.delete(c);
        update();
      });
      return b;
    };
    groupTabs.replaceChildren(tab('', 'All', total),
      ...idx.groups.filter((g) => counts.get(g) || f.group === g).map((g) => tab(g, g, counts.get(g) ?? 0)));
  }

  const label = (key: FacetKey, v: string) => (key === 'channel' ? idx.channelName.get(v) ?? v : v);

  function option(key: FacetKey, value: string, n: number): HTMLElement {
    const sel = f.facets[key];
    const id = `f-${key}-${value}`.replace(/[^\w-]/g, '_');
    const box = el('input', { type: 'checkbox', id, checked: sel.has(value) });
    box.addEventListener('change', () => { if (box.checked) sel.add(value); else sel.delete(value); update(); });
    return el('label', { class: `opt${n === 0 && !sel.has(value) ? ' zero' : ''}`, for: id },
      box, el('span', { class: 'opt-label' }, label(key, value)), el('span', { class: 'opt-count' }, n.toLocaleString('en')));
  }

  function section(id: string, name: string, active: number, body: Node[]): HTMLElement {
    const d = el('details', { class: 'facet', open: openSections.has(id) },
      el('summary', {}, el('span', {}, name), active ? el('span', { class: 'facet-active' }, String(active)) : null, icon('chevron', 16)),
      el('div', { class: 'facet-body' }, body));
    d.addEventListener('toggle', () => { if (d.open) openSections.add(id); else openSections.delete(id); });
    return d;
  }

  function ordered(key: FacetKey, counts: Map<string, number>): string[] {
    const present = [...new Set([...counts.keys(), ...f.facets[key]])];
    const tax = idx.lib.taxonomy;
    if (key === 'cat') {
      const order = (f.group ? [f.group] : idx.groups).flatMap((g) => (idx.categoriesByGroup.get(g) ?? []).map((c) => c.name));
      return present.filter((v) => order.includes(v)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .concat(present.filter((v) => !order.includes(v)));
    }
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
      const counts = facetCounts(base(), f, def.key);
      const values = ordered(def.key, counts).filter((v) => (counts.get(v) ?? 0) > 0 || f.facets[def.key].has(v));
      if (!values.length) continue;
      nodes.push(section(def.key, def.key === 'cat' && f.group ? `${f.group} categories` : def.label,
        f.facets[def.key].size, values.map((v) => option(def.key, v, counts.get(v) ?? 0))));
    }
    const radios = ADDED.map((a) => {
      const id = `added-${a.value || 'any'}`;
      const r = el('input', { type: 'radio', name: 'added', id, checked: f.added === a.value });
      r.addEventListener('change', () => { f.added = a.value; update(); });
      return el('label', { class: 'opt', for: id }, r, el('span', { class: 'opt-label' }, a.label));
    });
    nodes.push(section('added', 'Date added', f.added ? 1 : 0, radios));
    const thumb = el('input', { type: 'checkbox', id: 'only-preview', checked: f.thumb });
    thumb.addEventListener('change', () => { f.thumb = thumb.checked; update(); });
    nodes.push(el('label', { class: 'opt opt-switch', for: 'only-preview' }, thumb, el('span', { class: 'opt-label' }, 'Only with preview image')));
    facetsEl.replaceChildren(...nodes);
  }

  function renderChips(): void {
    const list: HTMLElement[] = [];
    const chip = (text: string, remove: () => void) => list.push(
      el('button', { class: 'chip', type: 'button', 'aria-label': `Remove filter ${text}`, onclick: () => { remove(); update(); } }, text, icon('close', 13)));
    for (const def of FACETS) for (const v of f.facets[def.key]) chip(label(def.key, v), () => f.facets[def.key].delete(v));
    if (f.added) chip(ADDED.find((a) => a.value === f.added)!.label, () => { f.added = ''; });
    if (f.thumb) chip('With preview', () => { f.thumb = false; });
    chips.replaceChildren(...list);
  }

  function update(): void {
    const results = applyFilters(base(), f, ranked !== null);
    grid.setItems(results);
    title.textContent = heading();
    const n = results.length;
    count.textContent = `${n.toLocaleString('en')} ${n === 1 ? 'model' : 'models'}`;
    showBtn.textContent = `Show ${n.toLocaleString('en')} ${n === 1 ? 'model' : 'models'}`;
    const active = activeFilterCount(f);
    const dot = filterBtn.querySelector<HTMLElement>('.count-dot')!;
    dot.hidden = !active;
    dot.textContent = String(active);
    sortSel.querySelector<HTMLOptionElement>('option[value="relevance"]')!.disabled = !f.q.trim();
    sortSel.value = !f.q.trim() && f.sort === 'relevance' ? 'new' : f.sort;
    if (n === 0) {
      empty.replaceChildren(icon('search', 36), el('h2', {}, 'No models found'),
        el('p', {}, f.q ? `Nothing matches “${f.q}” with these filters.` : 'No models match these filters.'),
        el('div', { class: 'empty-actions' },
          active ? el('button', { class: 'btn btn-primary', type: 'button', onclick: clearFilters }, 'Clear filters') : null,
          f.group ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { f.group = ''; update(); } }, 'Search all groups') : null));
    }
    empty.hidden = n !== 0;
    renderCrumbs();
    renderGroupTabs();
    renderFacets();
    renderChips();
    const qs = filtersToParams(f).toString();
    ctx.replace(`#/browse${qs ? `?${qs}` : ''}`);
  }

  if (f.q.trim()) void runSearch(); else update();

  return {
    el: root,
    destroy: () => { grid.destroy(); document.body.classList.remove('no-scroll'); },
    setQuery: (q: string) => {
      if (q === f.q) return;
      f.q = q;
      if (q.trim() && f.sort !== 'relevance' && !ranked) f.sort = 'relevance';
      void runSearch();
    },
  };
}
