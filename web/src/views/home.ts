// Home: editorial hero with a featured carousel, new this week, bento categories, collections.
import { card, metaLine, preview, studio, tilt } from '../cards';
import { browseHref, type AppCtx, type View } from '../ctx';
import { el, icon, relativeTime } from '../dom';
import type { Item } from '../types';

const WEEK = 7 * 86400;

/** Newest items with previews, one per category, for the hero carousel. */
function featured(ctx: AppCtx, n: number): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const it of ctx.idx.items) {
    if (!it.th || seen.has(it.c) || it.g === 'Uncategorized') continue;
    seen.add(it.c);
    out.push(it);
    if (out.length === n) break;
  }
  return out;
}

export function homeView(ctx: AppCtx): View {
  const { idx } = ctx;
  const now = Date.now() / 1000;
  const total = idx.items.length;
  const fresh = idx.items.filter((i) => i.d >= now - WEEK);
  const catCount = [...idx.categories.values()].filter((c) => c.group !== 'Uncategorized').length;

  // Hero ------------------------------------------------------------------------------------------
  const picks = featured(ctx, 5);
  const slides = picks.map((it, i) => {
    const s = el('div', { class: `slide${i === 0 ? ' on' : ''}` });
    const img = el('img', { src: ctx.thumbUrl(it.th!), alt: it.t, decoding: 'async' });
    studio(img, s);
    s.append(img);
    return s;
  });
  const dots = el('div', { class: 'dots', 'aria-hidden': 'true' }, picks.map((_, i) => el('i', { class: i === 0 ? 'on' : '' })));
  const capTitle = el('b');
  const capMeta = el('span', { class: 'cap-meta' });
  let current = 0;
  const show = (i: number) => {
    if (!picks.length) return;
    current = (i + picks.length) % picks.length;
    slides.forEach((s, k) => s.classList.toggle('on', k === current));
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === current));
    capTitle.textContent = picks[current].t;
    capMeta.textContent = `${picks[current].c} · ${metaLine(picks[current])}`;
  };
  show(0);
  const stage = el('div', { class: 'stage' }, slides, picks.length > 1 ? dots : null,
    picks.length ? el('div', { class: 'cap glass' },
      el('div', { class: 'cap-text' }, el('small', {}, 'Featured'), capTitle, capMeta),
      el('button', { class: 'pill primary sm', type: 'button', onclick: () => ctx.open(picks[current]) }, 'View')) : el('div', { class: 'stage-empty' }, icon('cube', 48)));
  tilt(stage);
  const timer = window.setInterval(() => {
    if (!stage.isConnected) { window.clearInterval(timer); return; }
    if (!stage.matches(':hover') && !document.hidden) show(current + 1);
  }, 5200);

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'hero-text' },
      el('span', { class: 'eyebrow' }, el('i', { class: 'live' }), `Updated ${relativeTime(ctx.updatedAt)}${fresh.length ? ` · ${fresh.length.toLocaleString('en')} new this week` : ''}`),
      el('h1', {}, 'Every model.', el('br'), el('span', { class: 'fade' }, 'One library.')),
      el('p', { class: 'lede' }, `${idx.lib.channels.length} Telegram channels, sorted into one place. Find a sofa, an olive tree or an HDRI, then open the post in a tap.`),
      el('div', { class: 'cta' },
        el('a', { class: 'pill primary', href: '#/browse' }, 'Browse the library'),
        el('button', { class: 'pill secondary', type: 'button', onclick: () => ctx.openSearch() }, 'Search', el('kbd', {}, '⌘K'))),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', {}, total.toLocaleString('en')), el('span', {}, 'models')),
        el('div', { class: 'stat' }, el('b', {}, String(idx.lib.channels.length)), el('span', {}, 'channels')),
        el('div', { class: 'stat' }, el('b', {}, String(catCount)), el('span', {}, 'categories')))),
    stage);

  // New this week -----------------------------------------------------------------------------------
  const shelfItems = (fresh.length ? fresh : idx.items).filter((i) => i.th).slice(0, 16);
  const newSec = el('section', { class: 'sec' },
    el('div', { class: 'sec-head' },
      el('div', {}, el('h2', {}, fresh.length ? 'New this week' : 'Latest additions'), el('p', {}, 'Fresh from your channels, newest first.')),
      el('a', { class: 'link', href: browseHref({ added: '7d', sort: 'new' }) }, 'See all', icon('chevron-right', 16))),
    el('div', { class: 'shelf bleed', role: 'list' }, shelfItems.map((i) => card(i, ctx))));

  // Bento categories --------------------------------------------------------------------------------
  const cats = [...idx.categories.values()].filter((c) => c.cover && c.group !== 'Uncategorized').sort((a, b) => b.count - a.count);
  const pickCats = cats.slice(0, 9);
  // Sizes repeat in a pattern that keeps every row full on a 4-column grid.
  const sizes = ['big', '', '', 'wide', '', '', '', '', 'wide'];
  const tiles = pickCats.map((c, i) => {
    const tile = el('a', { class: `tile ${sizes[i] ?? ''}`, href: browseHref({ g: c.group, cat: c.name }) },
      preview(c.cover!, ctx, 'pv tile-img'),
      el('span', { class: 'tile-label glass' }, el('b', {}, c.name), el('span', {}, `${c.count.toLocaleString('en')} models`)));
    return tile;
  });
  const rest = cats.slice(pickCats.length);
  const faces = rest.slice(0, 5).map((c) => {
    const img = el('img', { src: ctx.thumbUrl(c.cover!.th!), alt: '', loading: 'lazy', decoding: 'async' });
    const face = el('span', { class: 'face' }, img);
    studio(img, face);
    return face;
  });
  const restNames = rest.slice(0, 3).map((c) => c.name);
  const restLine = rest.length
    ? `Also ${restNames.join(', ')}${rest.length > restNames.length ? ` and ${rest.length - restNames.length} more` : ''}`
    : idx.groups.filter((g) => g !== 'Uncategorized').join(', ');
  tiles.push(el('a', { class: `tile all-tile${pickCats.length === 9 ? ' wide' : ''}`, href: '#/browse' },
    faces.length ? el('span', { class: 'faces', 'aria-hidden': 'true' }, faces) : null,
    el('span', { class: 'all-label' }, el('b', {}, `All ${catCount} categories`), el('span', {}, restLine)),
    el('span', { class: 'all-arrow', 'aria-hidden': 'true' }, icon('arrow-right', 22))));
  const catSec = el('section', { class: 'sec' },
    el('div', { class: 'sec-head' }, el('div', {}, el('h2', {}, 'Browse by category'), el('p', {}, 'Sorted automatically from every post.'))),
    el('div', { class: 'bento' }, tiles));

  // Collections -------------------------------------------------------------------------------------
  const colSec = el('section', { class: 'sec' });
  const renderCols = () => {
    colSec.replaceChildren(
      el('div', { class: 'sec-head' },
        el('div', {}, el('h2', {}, 'Your collections'), el('p', {}, 'Models saved for each project.')),
        el('a', { class: 'link', href: '#/saved' }, 'All saved', icon('chevron-right', 16))),
      collectionsRow(ctx, 3));
  };
  renderCols();
  const unsub = ctx.saved.subscribe(renderCols);

  return { el: el('div', { class: 'view wrap' }, hero, newSec, catSec, colSec), destroy: unsub };
}

export function collectionTile(ctx: AppCtx, name: string, ids: readonly string[], href: string, fav: boolean): HTMLElement {
  const covers = ids.map((id) => ctx.idx.byId.get(id)).filter((i): i is Item => !!i?.th).slice(0, 3);
  const mosaic = el('div', { class: `mosaic n${covers.length}` },
    covers.length ? covers.map((i) => {
      const img = el('img', { src: ctx.thumbUrl(i.th!), alt: '', loading: 'lazy' });
      const cell = el('div', {}, img);
      studio(img, cell);
      return cell;
    })
      : el('span', { class: 'mosaic-empty' }, icon(fav ? 'heart' : 'folder', 30)));
  return el('a', { class: 'col', href },
    mosaic,
    el('b', {}, fav ? el('span', { class: 'col-fav' }, icon('heart', 15)) : null, name),
    el('span', {}, `${ids.length} ${ids.length === 1 ? 'model' : 'models'}`));
}

/** Favorites + up to `limit` collections + a "New collection" tile. */
export function collectionsRow(ctx: AppCtx, limit = Infinity): HTMLElement {
  const cols = ctx.saved.collections.slice(0, limit);
  const newTile = el('a', { class: 'col', href: '#/saved?new=1' },
    el('div', { class: 'mosaic new-col' }, icon('plus', 40)),
    el('b', {}, 'New collection'), el('span', {}, 'For your next project'));
  return el('div', { class: 'cols' },
    collectionTile(ctx, 'Favorites', ctx.saved.favorites, '#/saved/fav', true),
    cols.map((c) => collectionTile(ctx, c.name, c.items, `#/saved/${c.id}`, false)),
    newTile);
}
