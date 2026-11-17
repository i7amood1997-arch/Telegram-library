import '@fontsource-variable/inter/wght.css';
import './style.css';
import { syncFavButtons } from './cards';
import { b64decode, b64encode, decryptWithKey, deriveKey, parseEnvelope } from './crypto.js';
import { type AppCtx, type View } from './ctx';
import { indexLibrary } from './data';
import { el, icon, safeLocal, safeSession, storage } from './dom';
import {
  createCollectionPicker, createDetail, createLightbox, createShareDialog, createToaster,
} from './overlays';
import { Saved } from './saved';
import { SearchIndex } from './search';
import { createSpotlight } from './spotlight';
import type { Item, Library, OwnerInfo } from './types';
import { browseView } from './views/browse';
import { homeView } from './views/home';
import { savedListView, savedOverview } from './views/saved';

// ---------------------------------------------------------------------------------------------
// Data location & persistence keys
// ---------------------------------------------------------------------------------------------

const DEMO = new URLSearchParams(location.search).has('demo');
const DATA_BASE = DEMO ? './demo/' : './';
const KEY_STORE = DEMO ? 'tl.key.demo' : 'tl.key';
const SAVED_STORE = DEMO ? 'tl.saved.demo' : 'tl.saved';
const LAST_VISIT = 'tl.lastVisit';
const NEW_SINCE = 'tl.newSince';
const THEME = 'tl.theme';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

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

function brandMark(size = 22): HTMLElement {
  return el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('cube', size));
}

function centerScreen(...children: Node[]): void {
  app.replaceChildren(el('main', { class: 'center-screen' }, ...children));
}

function showMessage(title: string, body: string): void {
  centerScreen(el('div', { class: 'panel' }, brandMark(), el('h1', {}, title), el('p', { class: 'muted' }, body),
    el('button', { class: 'btn btn-primary', type: 'button', onclick: () => void boot() }, 'Try again')));
}

async function boot(): Promise<void> {
  centerScreen(el('div', { class: 'loader', role: 'status' }, el('span', { class: 'spinner' }), 'Loading library…'));
  let env: Envelope;
  try {
    env = await fetchEnvelope();
  } catch (err) {
    if ((err as Error).message === 'empty') {
      showMessage('No library yet', 'The first sync has not published any data. Check the “Sync library” workflow in GitHub Actions, then refresh.');
    } else {
      showMessage('Could not load the library', 'Check your connection and try again.');
    }
    return;
  }
  const key = rememberedKey(env.saltB64);
  if (key) {
    let lib: Library | null = null;
    try {
      lib = (await decryptWithKey(env, key)) as Library;
    } catch {
      forgetKey(); // password changed or guest removed
    }
    if (lib) { startApp(lib, key); return; }
  }
  showLock(env);
}

function showLock(env: Envelope): void {
  const input = el('input', { type: 'password', id: 'pw', class: 'text-input', autocomplete: 'current-password', required: true, placeholder: 'Password', 'aria-label': 'Password' });
  const remember = el('input', { type: 'checkbox', id: 'remember', checked: true });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const button = el('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, 'Unlock');
  const form = el('form', { class: 'panel lock' },
    el('div', { class: 'lock-brand' }, brandMark(26), el('span', {}, 'Model Library')),
    el('h1', {}, 'Welcome back'),
    el('p', { class: 'muted' }, 'Enter your password to open the library.'),
    input,
    el('label', { class: 'check', for: 'remember' }, remember, 'Remember on this device'),
    error,
    button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Unlocking…';
    let key: Uint8Array;
    let lib: Library;
    try {
      key = await deriveKey(input.value, env.salt, env.iter);
      lib = (await decryptWithKey(env, key)) as Library;
    } catch {
      error.textContent = 'That password is not right. Try again.';
      button.disabled = false;
      button.textContent = 'Unlock';
      input.select();
      return;
    }
    storage.set(remember.checked ? safeLocal() : safeSession(), KEY_STORE, JSON.stringify({ k: b64encode(key), s: env.saltB64 }));
    startApp(lib, key);
  });
  centerScreen(form);
  input.focus();
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

/** Old links used ?q=…&cat=… and #m=<id>; turn them into the new hash routes. */
function migrateLegacyUrl(): void {
  const search = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (search.has('demo')) keep.set('demo', '');
  search.delete('demo');
  let hash = location.hash;
  const legacyItem = hash.match(/^#m=(.+)$/);
  if (legacyItem) hash = `#/m/${legacyItem[1]}`;
  if ([...search.keys()].length && !hash.startsWith('#/')) hash = `#/browse?${search.toString()}`;
  const qs = keep.toString().replace(/=(&|$)/g, '$1');
  if (hash !== location.hash || [...search.keys()].length) {
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${hash}`);
  }
}

// ---------------------------------------------------------------------------------------------
// App shell + router
// ---------------------------------------------------------------------------------------------

type Route =
  | { name: 'home' }
  | { name: 'browse'; params: URLSearchParams }
  | { name: 'saved'; params: URLSearchParams }
  | { name: 'saved-list'; which: string }
  | { name: 'item'; id: string };

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [path, query = ''] = h.split('?');
  if (path.startsWith('/m/')) return { name: 'item', id: decodeURIComponent(path.slice(3)) };
  if (path === '/browse') return { name: 'browse', params: new URLSearchParams(query) };
  if (path === '/saved') return { name: 'saved', params: new URLSearchParams(query) };
  if (path.startsWith('/saved/')) return { name: 'saved-list', which: decodeURIComponent(path.slice(7)) };
  return { name: 'home' };
}

function startApp(lib: Library, key: Uint8Array): void {
  migrateLegacyUrl();
  const idx = indexLibrary(lib);
  const saved = new Saved(SAVED_STORE);
  const newSince = computeNewSince();
  const toast = createToaster();
  const lightbox = createLightbox();

  let currentKey = '';
  let currentView: View | null = null;
  let lastViewHash = '#/';
  let itemPushed = false;

  const ctx: AppCtx = {
    idx,
    search: new SearchIndex(idx.items),
    saved,
    updatedAt: lib.updated_at,
    thumbUrl: (name) => `${DATA_BASE}thumbs/${name}`,
    isNew: (item) => item.d > newSince,
    open: (item: Item) => {
      itemPushed = true;
      location.hash = `#/m/${encodeURIComponent(item.id)}`;
    },
    go: (hash) => { if (location.hash !== hash) location.hash = hash; else route(); },
    replace: (hash) => {
      if (location.hash === hash) return;
      history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
      currentKey = hash;
      lastViewHash = hash;
      syncHeader();
    },
    toast,
    openSearch: () => {},
    pickCollections: (item) => picker(item),
  };
  const picker = createCollectionPicker(() => ctx);
  const detail = createDetail(() => ctx, lightbox);

  // Floating glass navigation ---------------------------------------------------------------------
  const spotlight = createSpotlight(() => ctx);
  ctx.openSearch = (q?: string) => spotlight.open(q);

  const groups = idx.groups.filter((g) => g !== 'Uncategorized');
  const seg = el('div', { class: 'seg nav-seg', role: 'group', 'aria-label': 'Groups' }, el('span', { class: 'seg-pill', 'aria-hidden': 'true' }));
  for (const g of ['All', ...groups]) {
    seg.append(el('a', { href: g === 'All' ? '#/browse' : `#/browse?g=${encodeURIComponent(g)}`, 'data-g': g === 'All' ? '' : g }, g));
  }
  const pill = seg.querySelector<HTMLElement>('.seg-pill')!;

  const savedCount = el('span', { class: 'badge-count', hidden: true });
  const savedLink = el('a', { class: 'icon-btn hide-sm', href: '#/saved', 'aria-label': 'Saved', title: 'Saved' }, icon('heart', 19), savedCount);
  const themeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Switch appearance', title: 'Switch appearance' });
  const setThemeIcon = () => themeBtn.replaceChildren(icon(currentTheme() === 'dark' ? 'sun' : 'moon', 19));
  setThemeIcon();
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storage.set(safeLocal(), THEME, next);
    setThemeIcon();
  });
  const shareBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Share access', title: 'Share access', hidden: true }, icon('users', 19));
  const lockBtn = el('button', { class: 'icon-btn hide-sm', type: 'button', 'aria-label': 'Lock', title: 'Lock library', onclick: () => { forgetKey(); location.reload(); } }, icon('lock', 19));
  const searchBtn = el('button', { class: 'search-btn', type: 'button', 'aria-label': 'Search', onclick: () => spotlight.open() },
    icon('search', 15), el('span', {}, 'Search'), el('kbd', {}, isMac ? '⌘K' : 'Ctrl K'));

  const header = el('header', { class: 'nav glass' },
    el('a', { class: 'logo', href: '#/' }, brandMark(15), el('span', { class: 'hide-sm' }, 'Library')),
    seg, searchBtn, savedLink, shareBtn, themeBtn, lockBtn);

  const tab = (key: string, label: string, ico: string, href: string | null) => href
    ? el('a', { href, 'data-tab': key }, icon(ico, 22), el('span', {}, label))
    : el('button', { type: 'button', 'data-tab': key, onclick: () => spotlight.open() }, icon(ico, 22), el('span', {}, label));
  const bottom = el('nav', { class: 'tabbar glass', 'aria-label': 'Sections' },
    tab('home', 'Home', 'home', '#/'), tab('browse', 'Browse', 'grid', '#/browse'), tab('search', 'Search', 'search', null), tab('saved', 'Saved', 'heart', '#/saved'));

  const main = el('main', { class: 'main', id: 'main' });
  app.replaceChildren(header, main, bottom);

  function placePill(): void {
    const on = seg.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!on) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    pill.style.left = `${on.offsetLeft}px`;
    pill.style.width = `${on.offsetWidth}px`;
  }
  window.addEventListener('resize', placePill);

  function syncHeader(): void {
    const r = parseRoute(lastViewHash);
    document.body.dataset.view = r.name;
    const p = r.name === 'browse' ? r.params : null;
    seg.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
      const on = !!p && !p.get('q') && (p.get('g') ?? '') === a.dataset.g;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    placePill();
    const tabKey = r.name === 'saved' || r.name === 'saved-list' ? 'saved' : r.name === 'browse' ? 'browse' : 'home';
    bottom.querySelectorAll<HTMLElement>('[data-tab]').forEach((a) => {
      if (a.dataset.tab === tabKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function syncSavedCount(): void {
    const n = saved.favorites.length;
    savedCount.hidden = !n;
    savedCount.textContent = n > 99 ? '99+' : String(n);
  }

  function renderView(hash: string): void {
    const r = parseRoute(hash);
    currentView?.destroy?.();
    currentView = r.name === 'browse' ? browseView(ctx, r.params)
      : r.name === 'saved' ? savedOverview(ctx, r.params)
        : r.name === 'saved-list' ? savedListView(ctx, r.which)
          : homeView(ctx);
    currentKey = hash;
    lastViewHash = hash;
    main.replaceChildren(currentView.el);
    window.scrollTo(0, 0);
    syncHeader();
  }

  function route(): void {
    const hash = location.hash || '#/';
    const r = parseRoute(hash);
    if (r.name === 'item') {
      const item = idx.byId.get(r.id);
      if (!currentView) renderView(lastViewHash);
      if (!item) { toast('That model is no longer in the library.'); ctx.replace(lastViewHash); return; }
      detail.open(item, () => {
        if (itemPushed) { itemPushed = false; history.back(); } else { location.hash = lastViewHash; }
      });
      return;
    }
    if (detail.isOpen) detail.close();
    if (spotlight.isOpen()) spotlight.close();
    itemPushed = false;
    if (hash !== currentKey) renderView(hash);
  }

  window.addEventListener('hashchange', route);
  saved.subscribe(() => { syncFavButtons(saved); syncSavedCount(); });
  syncSavedCount();

  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing = t.matches('input, textarea, select');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (spotlight.isOpen()) spotlight.close(); else spotlight.open();
    } else if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      spotlight.open();
    }
  });

  // Owner-only: guest passwords to share (owner.enc opens with the owner's key only).
  void (async () => {
    try {
      const res = await fetch(`${DATA_BASE}owner.enc`, { cache: 'no-cache' });
      if (!res.ok) return;
      const owner = (await decryptWithKey(parseEnvelope(await res.text()), key)) as OwnerInfo;
      const openShare = createShareDialog(owner);
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', openShare);
    } catch { /* not the owner */ }
  })();

  route();
}

void boot();
