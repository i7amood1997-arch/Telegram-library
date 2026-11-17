import './style.css';
import { b64decode, b64encode, decryptWithKey, deriveKey, parseEnvelope } from './crypto.js';
import {
  debounce, el, formatDate, formatSize, icon, relativeTime, safeLocal, safeSession, storage,
} from './dom';
import { VirtualGrid } from './grid';
import type { Added, FacetKey, Filters, Item, Library, OwnerInfo, Sort } from './types';

// ---------------------------------------------------------------------------------------------
// Data location & persistence keys
// ---------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const DATA_BASE = DEMO ? './demo/' : './';
const KEY_STORE = DEMO ? 'tl.key.demo' : 'tl.key';
const LAST_VISIT = 'tl.lastVisit';
const NEW_SINCE = 'tl.newSince';
const THEME = 'tl.theme';

const app = document.getElementById('app')!;

type Envelope = ReturnType<typeof parseEnvelope>;

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

function applyTheme(theme: string | null): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

applyTheme(storage.get(safeLocal(), THEME));

// ---------------------------------------------------------------------------------------------
// Boot: fetch encrypted data, unlock with remembered key or password
// ---------------------------------------------------------------------------------------------

async function fetchEnvelope(): Promise<Envelope> {
  const res = await fetch(`${DATA_BASE}library.enc`, { cache: 'no-cache' });
  if (res.status === 404) throw new Error('empty');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseEnvelope(await res.text());
}

function rememberedKey(saltB64: string): Uint8Array | null {
  for (const area of [safeSession(), safeLocal()]) {
    const raw = storage.get(area, KEY_STORE);
    if (!raw) continue;
    try {
      const { k, s } = JSON.parse(raw) as { k: string; s: string };
      if (s === saltB64) return b64decode(k);
    } catch { /* ignore malformed */ }
  }
  return null;
}

function forgetKey(): void {
  storage.remove(safeLocal(), KEY_STORE);
  storage.remove(safeSession(), KEY_STORE);
}

function centerScreen(...children: Node[]): void {
  app.replaceChildren(el('main', { class: 'center-screen' }, ...children));
}

function brandMark(): HTMLElement {
  return el('div', { class: 'brand-mark' }, icon('cube', 22));
}

function showMessage(title: string, body: string, retry = true): void {
  centerScreen(el('div', { class: 'panel' },
    brandMark(),
    el('h1', {}, title),
    el('p', { class: 'muted' }, body),
    retry ? el('button', { class: 'btn btn-primary', onclick: () => void boot() }, 'Try again') : null,
  ));
}

async function boot(): Promise<void> {
  centerScreen(el('div', { class: 'loader', role: 'status' }, el('span', { class: 'spinner' }),
    'Loading library…'));
  let env: Envelope;
  try {
    env = await fetchEnvelope();
  } catch (err) {
    if ((err as Error).message === 'empty') {
      showMessage('No library yet',
        'The first sync has not published any data yet. Check the "Sync library" workflow in GitHub Actions, then refresh.');
    } else {
      showMessage('Could not load the library', 'Check your connection and try again.');
    }
    return;
  }
  const key = rememberedKey(env.saltB64);
  if (key) {
    try {
      startApp((await decryptWithKey(env, key)) as Library, key);
      return;
    } catch {
      forgetKey();
    }
  }
  showLock(env);
}

function showLock(env: Envelope): void {
  const input = el('input', {
    type: 'password', id: 'pw', autocomplete: 'current-password', required: true,
    placeholder: 'Password', 'aria-label': 'Password',
  });
  const remember = el('input', { type: 'checkbox', id: 'remember', checked: true });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const button = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Unlock');

  const form = el('form', { class: 'panel lock' },
    brandMark(),
    el('h1', {}, 'Model Library'),
    el('p', { class: 'muted' }, 'Enter your password to unlock your library.'),
    input,
    el('label', { class: 'check', for: 'remember' }, remember, 'Remember on this device'),
    error,
    button,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Unlocking…';
    try {
      const key = await deriveKey(input.value, env.salt, env.iter);
      const lib = (await decryptWithKey(env, key)) as Library;
      const record = JSON.stringify({ k: b64encode(key), s: env.saltB64 });
      storage.set(remember.checked ? safeLocal() : safeSession(), KEY_STORE, record);
      startApp(lib, key);
    } catch {
      error.textContent = 'Incorrect password. Please try again.';
      button.disabled = false;
      button.textContent = 'Unlock';
      input.select();
    }
  });
  centerScreen(form);
  input.focus();
}

// ---------------------------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------------------------

const FACETS: { key: FacetKey; label: string; param: string }[] = [
  { key: 'cat', label: 'Category', param: 'cat' },
  { key: 'style', label: 'Style', param: 'style' },
  { key: 'engine', label: 'Render engine', param: 'engine' },
  { key: 'version', label: '3ds Max version', param: 'max' },
  { key: 'channel', label: 'Channel', param: 'ch' },
];

const ADDED: { value: Added; label: string; seconds: number }[] = [
  { value: '', label: 'Any time', seconds: 0 },
  { value: '1d', label: 'Last 24 hours', seconds: 86400 },
  { value: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
  { value: '30d', label: 'Last 30 days', seconds: 30 * 86400 },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'new', label: 'Newest' },
  { value: 'old', label: 'Oldest' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'size', label: 'Largest' },
];

function facetValue(item: Item, key: FacetKey): string {
  switch (key) {
    case 'cat': return item.c;
    case 'style': return item.s;
    case 'engine': return item.r;
    case 'version': return item.mv ?? 'Unknown';
    case 'channel': return String(item.ch);
  }
}

function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const facets = {} as Filters['facets'];
  for (const f of FACETS) {
    facets[f.key] = new Set((p.get(f.param) ?? '').split('|').filter(Boolean));
  }
  const added = (p.get('added') ?? '') as Added;
  const sort = (p.get('sort') ?? '') as Sort;
  return {
    q: p.get('q') ?? '',
    facets,
    added: ADDED.some((a) => a.value === added) ? added : '',
    thumb: p.get('preview') === '1',
    sort: SORTS.some((s) => s.value === sort) ? sort : 'relevance',
  };
}

function writeFilters(f: Filters): void {
  const p = new URLSearchParams();
  if (DEMO) p.set('demo', '');
  if (f.q) p.set('q', f.q);
  for (const def of FACETS) {
    if (f.facets[def.key].size) p.set(def.param, [...f.facets[def.key]].join('|'));
  }
  if (f.added) p.set('added', f.added);
  if (f.thumb) p.set('preview', '1');
  if (f.sort !== 'relevance') p.set('sort', f.sort);
  const qs = p.toString().replace(/demo=(&|$)/, 'demo$1');
  history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

function computeNewSince(): number {
  const session = safeSession();
  const existing = storage.get(session, NEW_SINCE);
  if (existing) return Number(existing);
  const last = Number(storage.get(safeLocal(), LAST_VISIT) ?? 0);
  const since = last || Date.now() / 1000;
  storage.set(session, NEW_SINCE, String(since));
  storage.set(safeLocal(), LAST_VISIT, String(Date.now() / 1000));
  return since;
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

function startApp(lib: Library, key: Uint8Array): void {
  const items = lib.items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const channelName = new Map(lib.channels.map((c) => [String(c.id), c.title || `Channel ${c.id}`]));
  const newSince = computeNewSince();
  const isNew = (i: Item) => i.d > newSince;
  const thumbUrl = (name: string) => `${DATA_BASE}thumbs/${name}`;
  const filters = readFilters();

  // Search worker ------------------------------------------------------------------------------
  const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  let searchReady = false;
  let searchSeq = 0;
  let searchIds: string[] | null = null;
  worker.onmessage = (ev) => {
    const msg = ev.data as { type: string; id?: number; ids?: string[] };
    if (msg.type === 'ready') {
      searchReady = true;
      if (filters.q) runSearch();
    } else if (msg.type === 'results' && msg.id === searchSeq) {
      searchIds = msg.ids ?? [];
      update();
    }
  };
  worker.postMessage({ type: 'index', items });

  function runSearch(): void {
    const q = filters.q.trim();
    if (!q) {
      searchIds = null;
      update();
      return;
    }
    if (!searchReady) return;
    searchSeq += 1;
    worker.postMessage({ type: 'search', id: searchSeq, q });
  }

  // Layout -------------------------------------------------------------------------------------
  const search = el('input', {
    type: 'search', class: 'search-input', placeholder: 'Search models, tags, files…',
    'aria-label': 'Search', value: filters.q, autocomplete: 'off', spellcheck: 'false',
  });
  const themeBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Toggle theme', title: 'Toggle theme',
  });
  const setThemeIcon = () => themeBtn.replaceChildren(icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
  setThemeIcon();
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storage.set(safeLocal(), THEME, next);
    setThemeIcon();
  });
  const shareBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Share access', title: 'Share access',
    hidden: true, onclick: () => openShare(),
  }, icon('users'));
  const lockBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Lock', title: 'Lock library',
    onclick: () => { forgetKey(); location.reload(); },
  }, icon('lock'));
  const filtersBtn = el('button', {
    class: 'btn btn-ghost filters-toggle', type: 'button', 'aria-controls': 'sidebar',
    'aria-expanded': 'false',
  }, icon('filter', 16), 'Filters');

  const header = el('header', { class: 'topbar' },
    el('div', { class: 'brand' }, brandMark(), el('span', { class: 'brand-name' }, 'Model Library')),
    el('div', { class: 'search' }, icon('search', 18), search, el('kbd', { class: 'kbd' }, '/')),
    el('div', { class: 'topbar-actions' }, shareBtn, themeBtn, lockBtn),
  );

  const facetRoot = el('div', { class: 'facets' });
  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Filters' },
    el('div', { class: 'sidebar-head' },
      el('span', {}, 'Filters'),
      el('button', {
        class: 'icon-btn sidebar-close', type: 'button', 'aria-label': 'Close filters',
        onclick: () => toggleSidebar(false),
      }, icon('close')),
    ),
    facetRoot,
    el('div', { class: 'sidebar-foot muted' },
      `${items.length.toLocaleString('en')} models · Updated ${relativeTime(lib.updated_at)}`),
  );
  const scrim = el('div', { class: 'scrim', onclick: () => toggleSidebar(false) });

  const countEl = el('div', { class: 'result-count', 'aria-live': 'polite' });
  const chipsEl = el('div', { class: 'chips' });
  const sortSel = el('select', { class: 'select', 'aria-label': 'Sort by' },
    SORTS.map((s) => el('option', { value: s.value }, s.label)));
  sortSel.value = filters.sort;
  sortSel.addEventListener('change', () => {
    filters.sort = sortSel.value as Sort;
    update();
  });

  const gridRoot = el('div', { class: 'grid', role: 'list' });
  const emptyEl = el('div', { class: 'empty-state', hidden: true });
  const main = el('main', { class: 'content' },
    el('div', { class: 'toolbar' },
      filtersBtn,
      countEl,
      el('div', { class: 'toolbar-spacer' }),
      el('label', { class: 'sort' }, el('span', { class: 'muted' }, 'Sort'), sortSel),
    ),
    chipsEl,
    emptyEl,
    gridRoot,
  );

  const dialog = el('dialog', { class: 'detail', 'aria-label': 'Model details' });
  const shareDialog = el('dialog', { class: 'share', 'aria-label': 'Share access' });
  shareDialog.addEventListener('click', (e) => { if (e.target === shareDialog) shareDialog.close(); });
  app.replaceChildren(header, el('div', { class: 'layout' }, sidebar, main), scrim, dialog,
    shareDialog);

  // Owner-only: guest passwords to share. owner.enc opens with the owner's key only, so the
  // button never appears for guests.
  let owner: OwnerInfo | null = null;
  void (async () => {
    try {
      const res = await fetch(`${DATA_BASE}owner.enc`, { cache: 'no-cache' });
      if (!res.ok) return;
      owner = (await decryptWithKey(parseEnvelope(await res.text()), key)) as OwnerInfo;
      shareBtn.hidden = false;
    } catch { /* not the owner */ }
  })();

  function copyButton(label: string, text: string): HTMLButtonElement {
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('copy', 15), label);
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        btn.replaceChildren(icon('check', 15), 'Copied');
      } catch {
        btn.replaceChildren('Copy failed');
      }
      setTimeout(() => btn.replaceChildren(icon('copy', 15), label), 1600);
    });
    return btn;
  }

  function openShare(): void {
    if (!owner) return;
    const siteUrl = `${location.origin}${location.pathname}`;
    const rows = owner.guests.map((g) => el('li', { class: 'guest' },
      el('div', { class: 'guest-head' },
        el('strong', {}, g.name),
        el('span', { class: 'muted small' }, `added ${relativeTime(g.created)}`)),
      el('code', { class: 'guest-pw' }, g.password),
      el('div', { class: 'guest-actions' },
        copyButton('Copy password', g.password),
        copyButton('Copy invite', `Model Library\n${siteUrl}\nPassword: ${g.password}`)),
    ));
    shareDialog.replaceChildren(el('div', { class: 'share-inner' },
      el('div', { class: 'share-head' },
        el('h2', {}, 'Share access'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close',
          onclick: () => shareDialog.close() }, icon('close'))),
      el('p', { class: 'muted' }, 'Guests can browse and search the library. Only you can see this list.'),
      rows.length ? el('ul', { class: 'guest-list' }, rows)
        : el('p', { class: 'empty-note' }, 'No guests yet.'),
      owner.secret_guests ? el('p', { class: 'muted small' },
        `${owner.secret_guests} more guest password(s) are set in the GUEST_PASSWORDS secret.`) : null,
      el('p', { class: 'muted small' },
        'To add or remove a guest, run the “Sync library” workflow with mode add-guest or remove-guest and the guest’s name.'),
    ));
    shareDialog.showModal();
  }

  function toggleSidebar(open: boolean): void {
    document.body.classList.toggle('sidebar-open', open);
    filtersBtn.setAttribute('aria-expanded', String(open));
  }
  filtersBtn.addEventListener('click', () => toggleSidebar(!document.body.classList.contains('sidebar-open')));

  const grid = new VirtualGrid(gridRoot, thumbUrl, isNew, (item) => openDetail(item));

  // Filtering ----------------------------------------------------------------------------------
  function passesOther(item: Item, except: FacetKey | 'added' | 'thumb' | null, now: number): boolean {
    for (const def of FACETS) {
      if (def.key === except) continue;
      const sel = filters.facets[def.key];
      if (sel.size && !sel.has(facetValue(item, def.key))) return false;
    }
    if (except !== 'added' && filters.added) {
      const secs = ADDED.find((a) => a.value === filters.added)!.seconds;
      if (item.d < now - secs) return false;
    }
    if (except !== 'thumb' && filters.thumb && !item.th) return false;
    return true;
  }

  function currentResults(): Item[] {
    const now = Date.now() / 1000;
    const base = searchIds ? searchIds.map((id) => byId.get(id)!).filter(Boolean) : items;
    const out = base.filter((i) => passesOther(i, null, now));
    const sort = filters.sort === 'relevance' && !searchIds ? 'new' : filters.sort;
    switch (sort) {
      case 'new': out.sort((a, b) => b.d - a.d); break;
      case 'old': out.sort((a, b) => a.d - b.d); break;
      case 'title': out.sort((a, b) => a.t.localeCompare(b.t)); break;
      case 'size': out.sort((a, b) => b.sz - a.sz); break;
      default: break;
    }
    return out;
  }

  function facetCounts(key: FacetKey): Map<string, number> {
    const now = Date.now() / 1000;
    const base = searchIds ? searchIds.map((id) => byId.get(id)!).filter(Boolean) : items;
    const counts = new Map<string, number>();
    for (const it of base) {
      if (!passesOther(it, key, now)) continue;
      const v = facetValue(it, key);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return counts;
  }

  // Facets UI ----------------------------------------------------------------------------------
  const openSections = new Set<string>(['cat']);
  const valueLabel = (key: FacetKey, v: string) => (key === 'channel' ? channelName.get(v) ?? v : v);

  function optionRow(key: FacetKey, value: string, count: number, label = valueLabel(key, value),
    extraClass = ''): HTMLElement {
    const sel = filters.facets[key];
    const id = `f-${key}-${value}`.replace(/[^\w-]/g, '_');
    const box = el('input', { type: 'checkbox', id, checked: sel.has(value) });
    box.addEventListener('change', () => {
      if (box.checked) sel.add(value); else sel.delete(value);
      update();
    });
    return el('label', { class: `opt ${extraClass} ${count === 0 && !sel.has(value) ? 'zero' : ''}`, for: id },
      box, el('span', { class: 'opt-label' }, label), el('span', { class: 'opt-count' }, count.toLocaleString('en')));
  }

  function section(id: string, title: string, active: number, body: Node[]): HTMLElement {
    const det = el('details', { class: 'facet', open: openSections.has(id) },
      el('summary', {}, el('span', {}, title),
        active ? el('span', { class: 'facet-active' }, String(active)) : null,
        icon('chevron', 16)),
      el('div', { class: 'facet-body' }, body),
    );
    det.addEventListener('toggle', () => {
      if (det.open) openSections.add(id); else openSections.delete(id);
    });
    return det;
  }

  function orderedValues(key: FacetKey, counts: Map<string, number>): string[] {
    const present = new Set([...counts.keys(), ...filters.facets[key]]);
    const tax = lib.taxonomy;
    let order: string[] = [];
    if (key === 'style') order = tax.styles;
    if (key === 'engine') order = tax.render_engines;
    if (key === 'version') {
      return [...present].sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : b.localeCompare(a)));
    }
    if (key === 'channel') {
      return [...present].sort((a, b) => valueLabel(key, a).localeCompare(valueLabel(key, b)));
    }
    const ordered = order.filter((v) => present.has(v));
    return [...ordered, ...[...present].filter((v) => !order.includes(v)).sort()];
  }

  function renderFacets(): void {
    const nodes: Node[] = [];
    // Category tree
    const catCounts = facetCounts('cat');
    const groups: [string, string[]][] = Object.entries(lib.taxonomy.categories);
    const known = new Set(groups.flatMap(([, c]) => c));
    const unknown = [...catCounts.keys()].filter((c) => !known.has(c));
    if (unknown.length) groups.push(['Uncategorized', unknown]);
    const catSel = filters.facets.cat;
    const tree = groups.map(([group, cats]) => {
      const visible = cats.filter((c) => (catCounts.get(c) ?? 0) > 0 || catSel.has(c));
      if (!visible.length) return null;
      const total = visible.reduce((n, c) => n + (catCounts.get(c) ?? 0), 0);
      const all = visible.every((c) => catSel.has(c));
      const some = visible.some((c) => catSel.has(c));
      if (visible.length === 1 && visible[0] === group) {
        return optionRow('cat', group, catCounts.get(group) ?? 0, group, 'opt-group');
      }
      const gid = `g-${group}`.replace(/[^\w-]/g, '_');
      const gbox = el('input', { type: 'checkbox', id: gid, checked: all });
      gbox.indeterminate = some && !all;
      gbox.addEventListener('change', () => {
        for (const c of visible) { if (gbox.checked) catSel.add(c); else catSel.delete(c); }
        update();
      });
      return el('div', { class: 'tree-group' },
        el('label', { class: 'opt opt-group', for: gid }, gbox,
          el('span', { class: 'opt-label' }, group), el('span', { class: 'opt-count' }, total.toLocaleString('en'))),
        el('div', { class: 'tree-children' },
          visible.map((c) => optionRow('cat', c, catCounts.get(c) ?? 0))),
      );
    });
    nodes.push(section('cat', 'Category', catSel.size, tree.filter(Boolean) as Node[]));

    for (const def of FACETS.slice(1)) {
      const counts = facetCounts(def.key);
      const values = orderedValues(def.key, counts);
      if (!values.length) continue;
      nodes.push(section(def.key, def.label, filters.facets[def.key].size,
        values.map((v) => optionRow(def.key, v, counts.get(v) ?? 0))));
    }

    // Date added
    const radios = ADDED.map((a) => {
      const id = `added-${a.value || 'any'}`;
      const r = el('input', { type: 'radio', name: 'added', id, checked: filters.added === a.value });
      r.addEventListener('change', () => { filters.added = a.value; update(); });
      return el('label', { class: 'opt', for: id }, r, el('span', { class: 'opt-label' }, a.label));
    });
    nodes.push(section('added', 'Date added', filters.added ? 1 : 0, radios));

    const thumbBox = el('input', { type: 'checkbox', id: 'only-preview', checked: filters.thumb });
    thumbBox.addEventListener('change', () => { filters.thumb = thumbBox.checked; update(); });
    nodes.push(el('label', { class: 'opt opt-switch', for: 'only-preview' }, thumbBox,
      el('span', { class: 'opt-label' }, 'Only with preview image')));

    facetRoot.replaceChildren(...nodes);
  }

  // Chips --------------------------------------------------------------------------------------
  function renderChips(): void {
    const chips: HTMLElement[] = [];
    const chip = (label: string, onRemove: () => void) => chips.push(
      el('button', { class: 'chip', type: 'button', 'aria-label': `Remove filter ${label}`,
        onclick: () => { onRemove(); update(); } }, label, icon('close', 14)));
    for (const def of FACETS) {
      for (const v of filters.facets[def.key]) chip(valueLabel(def.key, v), () => filters.facets[def.key].delete(v));
    }
    if (filters.added) chip(ADDED.find((a) => a.value === filters.added)!.label, () => { filters.added = ''; });
    if (filters.thumb) chip('With preview', () => { filters.thumb = false; });
    if (chips.length > 1) {
      chips.push(el('button', { class: 'chip-clear', type: 'button', onclick: clearAll }, 'Clear all'));
    }
    chipsEl.replaceChildren(...chips);
    chipsEl.hidden = chips.length === 0;
  }

  function clearAll(): void {
    for (const def of FACETS) filters.facets[def.key].clear();
    filters.added = '';
    filters.thumb = false;
    update();
  }

  // Update cycle -------------------------------------------------------------------------------
  function update(): void {
    if (filters.q.trim() && searchIds === null) {
      // Search index still building: wait for the first results instead of flashing all items.
      countEl.textContent = 'Searching…';
      writeFilters(filters);
      return;
    }
    const results = currentResults();
    grid.setItems(results);
    const n = results.length;
    countEl.textContent = `${n.toLocaleString('en')} ${n === 1 ? 'model' : 'models'}`;
    sortSel.querySelector<HTMLOptionElement>('option[value="relevance"]')!.disabled = !filters.q.trim();
    if (!filters.q.trim() && filters.sort === 'relevance') sortSel.value = 'new';
    else sortSel.value = filters.sort;

    const activeFilters = FACETS.some((d) => filters.facets[d.key].size) || filters.added || filters.thumb;
    if (items.length === 0) {
      emptyEl.replaceChildren(icon('cube', 40), el('h2', {}, 'Your library is empty'),
        el('p', { class: 'muted' }, 'New models appear here automatically after each sync.'));
    } else if (n === 0) {
      emptyEl.replaceChildren(icon('search', 40), el('h2', {}, 'No models found'),
        el('p', { class: 'muted' }, filters.q ? `Nothing matches “${filters.q}”${activeFilters ? ' with the current filters' : ''}.` : 'No models match the current filters.'),
        el('div', { class: 'empty-actions' },
          activeFilters ? el('button', { class: 'btn btn-primary', onclick: clearAll }, 'Clear filters') : null,
          filters.q ? el('button', { class: 'btn btn-ghost', onclick: () => { search.value = ''; onSearch(); } }, 'Clear search') : null,
        ));
    }
    emptyEl.hidden = n !== 0;
    renderFacets();
    renderChips();
    writeFilters(filters);
  }

  const onSearch = () => {
    filters.q = search.value;
    runSearch();
  };
  search.addEventListener('input', debounce(onSearch, 120));

  // Detail -------------------------------------------------------------------------------------
  function infoRow(label: string, value: Node | string | null): HTMLElement | null {
    if (value === null || value === '') return null;
    return el('div', { class: 'info-row' }, el('dt', {}, label), el('dd', {}, value));
  }

  function filterLink(key: FacetKey, value: string, label = valueLabel(key, value)): HTMLElement {
    return el('button', { class: 'link-btn', type: 'button', onclick: () => {
      for (const def of FACETS) filters.facets[def.key].clear();
      filters.facets[key].add(value);
      closeDetail();
      update();
    } }, label);
  }

  function openDetail(item: Item, push = true): void {
    const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, icon('copy', 16), 'Copy link');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.l);
        copyBtn.replaceChildren(icon('check', 16), 'Copied');
      } catch {
        copyBtn.replaceChildren('Copy failed');
      }
      setTimeout(() => copyBtn.replaceChildren(icon('copy', 16), 'Copy link'), 1600);
    });

    const media = el('div', { class: 'detail-media' },
      item.th ? el('img', { src: thumbUrl(item.th), alt: item.t }) : icon('cube', 64));

    const tagBtns = item.tg.map((t) => el('button', { class: 'tag tag-btn', type: 'button', onclick: () => {
      search.value = t; closeDetail(); onSearch();
    } }, t));

    dialog.replaceChildren(
      el('div', { class: 'detail-inner' },
        el('button', { class: 'icon-btn detail-close', type: 'button', 'aria-label': 'Close', onclick: () => closeDetail() }, icon('close')),
        media,
        el('div', { class: 'detail-body' },
          el('div', { class: 'detail-kicker' }, `${item.g} / ${item.c}`),
          el('h2', { class: 'detail-title' }, item.t),
          el('div', { class: 'detail-actions' },
            el('a', { class: 'btn btn-primary', href: item.l, target: '_blank', rel: 'noopener noreferrer' }, icon('send', 16), 'Open in Telegram'),
            copyBtn,
          ),
          tagBtns.length ? el('div', { class: 'detail-tags' }, tagBtns) : null,
          el('dl', { class: 'info' },
            infoRow('Category', filterLink('cat', item.c)),
            infoRow('Style', filterLink('style', item.s)),
            infoRow('Render engine', filterLink('engine', item.r)),
            infoRow('3ds Max', item.mv ? filterLink('version', item.mv) : 'Unknown'),
            infoRow('Channel', filterLink('channel', String(item.ch))),
            infoRow('Posted', `${formatDate(item.d)} (${relativeTime(item.d)})`),
            infoRow('Total size', formatSize(item.sz)),
            infoRow('Materials', item.m.join(', ')),
            infoRow('Colors', item.co.join(', ')),
          ),
          el('div', { class: 'files' },
            el('h3', {}, item.f.length > 1 ? `Files (${item.f.length})` : 'File'),
            el('ul', {}, item.f.map(([name, size]) => el('li', {}, icon('file', 16),
              el('span', { class: 'file-name' }, name), el('span', { class: 'muted' }, formatSize(size))))),
          ),
          item.cap ? el('details', { class: 'caption' }, el('summary', {}, 'Original caption'),
            el('p', { dir: 'auto' }, item.cap)) : null,
          item.p ? null : el('p', { class: 'muted small' }, 'Not classified yet: details may be incomplete.'),
        ),
      ),
    );
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    if (push && location.hash !== `#m=${encodeURIComponent(item.id)}`) {
      history.pushState({ modal: true }, '', `${location.pathname}${location.search}#m=${encodeURIComponent(item.id)}`);
    }
  }

  function closeDetail(): void {
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('close', () => {
    if (location.hash.startsWith('#m=')) {
      if (history.state?.modal) history.back();
      else history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDetail(); });

  function syncHash(): void {
    const m = location.hash.match(/^#m=(.+)$/);
    const item = m ? byId.get(decodeURIComponent(m[1])) : undefined;
    if (item) openDetail(item, false);
    else closeDetail();
  }
  window.addEventListener('popstate', syncHash);

  // Keyboard -----------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const typing = target.matches('input, textarea, select');
    if (e.key === '/' && !typing && !dialog.open) {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === 'Escape' && target === search && search.value) {
      search.value = '';
      onSearch();
    } else if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      toggleSidebar(false);
    }
  });

  update();
  syncHash();
}

void boot();
