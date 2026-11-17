// Home: search, categories by group, new this week, collections.
import { card } from '../cards';
import { browseHref, type AppCtx, type View } from '../ctx';
import { el, icon, relativeTime } from '../dom';
import { attachSuggest } from '../suggest';
import { suggestionHref } from './shared';

const WEEK = 7 * 86400;

export function homeView(ctx: AppCtx): View {
  const { idx } = ctx;
  const total = idx.items.length;
  const now = Date.now() / 1000;

  // Hero --------------------------------------------------------------------------------------
  const search = el('input', {
    type: 'search', id: 'home-search', class: 'hero-input', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Sofa, olive tree, oak texture, HDRI…', 'aria-label': 'Search the library',
  });
  attachSuggest(search, idx, (s) => ctx.go(suggestionHref(s)));
  const popular = [...idx.categories.values()].filter((c) => c.group !== 'Uncategorized')
    .sort((a, b) => b.count - a.count).slice(0, 6);
  const hero = el('section', { class: 'hero' },
    el('p', { class: 'eyebrow' }, `${total.toLocaleString('en')} models · ${idx.lib.channels.length} channels · updated ${relativeTime(ctx.updatedAt)}`),
    el('h1', {}, 'Find the right model for your next render'),
    el('div', { class: 'hero-search' }, icon('search', 20), search),
    el('div', { class: 'quick' },
      el('span', { class: 'quick-label' }, 'Popular'),
      popular.map((c) => el('a', { class: 'pill', href: browseHref({ g: c.group, cat: c.name }) }, c.name))),
  );

  // Categories by group -------------------------------------------------------------------------
  const tabs = el('div', { class: 'tabs tabs-scroll', role: 'tablist', 'aria-label': 'Category groups' });
  const tiles = el('div', { class: 'cat-grid', role: 'tabpanel' });
  const groups = idx.groups.filter((g) => (idx.categoriesByGroup.get(g) ?? []).length);
  const showGroup = (g: string) => {
    [...tabs.children].forEach((t) => t.setAttribute('aria-selected', String((t as HTMLElement).dataset.g === g)));
    const cats = idx.categoriesByGroup.get(g) ?? [];
    tiles.replaceChildren(...cats.map((c) => {
      const cover = el('div', { class: 'cat-cover' });
      if (c.cover?.th) cover.append(el('img', { src: ctx.thumbUrl(c.cover.th), alt: '', loading: 'lazy', decoding: 'async' }));
      else cover.append(icon(g === 'Resources' ? 'layers' : 'cube', 30));
      return el('a', { class: 'cat-tile', href: browseHref({ g, cat: c.name }) },
        cover,
        el('span', { class: 'cat-name' }, c.name),
        el('span', { class: 'cat-count' }, `${c.count.toLocaleString('en')} ${c.count === 1 ? 'model' : 'models'}`));
    }));
  };
  for (const g of groups) {
    const n = (idx.categoriesByGroup.get(g) ?? []).reduce((s, c) => s + c.count, 0);
    tabs.append(el('button', { class: 'tab', type: 'button', role: 'tab', 'data-g': g, onclick: () => showGroup(g) },
      g, el('span', { class: 'tab-count' }, n.toLocaleString('en'))));
  }
  if (groups.length) showGroup(groups[0]);

  const categories = el('section', { class: 'block' },
    el('div', { class: 'block-head' },
      el('h2', {}, 'Browse by category'),
      el('a', { class: 'more', href: '#/browse' }, 'All models', icon('arrow', 16))),
    tabs, tiles);

  // New this week -------------------------------------------------------------------------------
  let fresh = idx.items.filter((i) => i.d >= now - WEEK);
  const freshLabel = fresh.length ? 'New this week' : 'Latest additions';
  if (!fresh.length) fresh = idx.items.slice(0, 20);
  const newRow = el('section', { class: 'block' },
    el('div', { class: 'block-head' },
      el('h2', {}, freshLabel, fresh.length > 1 ? el('span', { class: 'head-count' }, fresh.length.toLocaleString('en')) : null),
      el('a', { class: 'more', href: browseHref({ added: '7d', sort: 'new' }) }, 'See all', icon('arrow', 16))),
    el('div', { class: 'row-scroll', role: 'list' }, fresh.slice(0, 18).map((i) => card(i, ctx))),
  );

  // Collections -----------------------------------------------------------------------------------
  const collectionsBlock = el('section', { class: 'block', hidden: true });
  const renderCollections = () => {
    const cols = ctx.saved.collections;
    const favs = ctx.saved.favorites;
    collectionsBlock.hidden = !cols.length && !favs.length;
    if (collectionsBlock.hidden) return;
    collectionsBlock.replaceChildren(
      el('div', { class: 'block-head' },
        el('h2', {}, 'Your saved models'),
        el('a', { class: 'more', href: '#/saved' }, 'Manage', icon('arrow', 16))),
      el('div', { class: 'col-grid' },
        favs.length ? collectionTile(ctx, 'Favorites', favs, '#/saved/fav', true) : null,
        cols.slice(0, 7).map((c) => collectionTile(ctx, c.name, c.items, `#/saved/${c.id}`, false))));
  };
  renderCollections();
  const unsub = ctx.saved.subscribe(renderCollections);

  // Styles ----------------------------------------------------------------------------------------
  const styles = [...idx.styleCounts.entries()].filter(([s]) => s !== 'Other').sort((a, b) => b[1] - a[1]);
  const stylesBlock = styles.length ? el('section', { class: 'block' },
    el('div', { class: 'block-head' }, el('h2', {}, 'Browse by style')),
    el('div', { class: 'style-list' }, styles.map(([s, n]) =>
      el('a', { class: 'style-chip', href: browseHref({ style: s }) }, s, el('span', {}, n.toLocaleString('en')))))) : null;

  const root = el('div', { class: 'page home' }, hero, collectionsBlock, newRow, categories, stylesBlock);
  return { el: root, destroy: unsub };
}

export function collectionTile(ctx: AppCtx, name: string, ids: readonly string[], href: string, fav: boolean): HTMLElement {
  const covers = ids.map((id) => ctx.idx.byId.get(id)).filter((i) => i?.th).slice(0, 4);
  const mosaic = el('div', { class: `mosaic n${covers.length}` },
    covers.length ? covers.map((i) => el('img', { src: ctx.thumbUrl(i!.th!), alt: '', loading: 'lazy' }))
      : el('span', { class: 'mosaic-empty' }, icon(fav ? 'heart' : 'folder', 28)));
  return el('a', { class: 'col-tile', href },
    mosaic,
    el('span', { class: 'col-name' }, fav ? el('span', { class: 'col-fav' }, icon('heart', 15)) : null, name),
    el('span', { class: 'col-count' }, `${ids.length} ${ids.length === 1 ? 'model' : 'models'}`));
}
