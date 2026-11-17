// Product-style model card used by every grid and row.
import { el, formatSize, icon } from './dom';
import type { Saved } from './saved';
import type { Item } from './types';

export interface CardContext {
  thumbUrl: (name: string) => string;
  isNew: (item: Item) => boolean;
  saved: Saved;
  open: (item: Item) => void;
}

export function metaLine(item: Item): string {
  const parts = [];
  if (item.g === 'Resources') parts.push(item.c);
  else if (item.r !== 'Unknown') parts.push(item.r);
  if (item.mv) parts.push(`Max ${item.mv}`);
  parts.push(formatSize(item.sz));
  return parts.join(' · ');
}

export function media(item: Item, ctx: CardContext, cls = 'card-media'): HTMLElement {
  const box = el('div', { class: cls });
  if (item.th) {
    const img = el('img', { src: ctx.thumbUrl(item.th), alt: '', decoding: 'async', draggable: 'false', loading: 'lazy' });
    img.addEventListener('load', () => box.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => box.classList.add('broken'), { once: true });
    box.append(img);
  } else {
    box.classList.add('empty');
    box.append(icon(item.g === 'Resources' ? 'layers' : 'cube', 34));
  }
  return box;
}

export function favButton(item: Item, ctx: CardContext): HTMLButtonElement {
  const on = ctx.saved.isFavorite(item.id);
  const btn = el('button', {
    class: 'fav', type: 'button', 'data-fav': item.id, 'aria-pressed': String(on),
    'aria-label': on ? 'Remove from favorites' : 'Add to favorites',
  }, icon('heart', 17));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.saved.toggleFavorite(item.id);
  });
  return btn;
}

/** Keep every heart on screen in sync after favorites change anywhere. */
export function syncFavButtons(saved: Saved): void {
  document.querySelectorAll<HTMLButtonElement>('[data-fav]').forEach((b) => {
    const on = saved.isFavorite(b.dataset.fav!);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  });
}

export function card(item: Item, ctx: CardContext): HTMLElement {
  const m = media(item, ctx);
  const badges = el('div', { class: 'badges' },
    ctx.isNew(item) ? el('span', { class: 'badge badge-new' }, 'New') : null,
    item.col ? el('span', { class: 'badge' }, 'Pack') : null,
    item.f.length > 1 ? el('span', { class: 'badge' }, `${item.f.length} parts`) : null,
  );
  m.append(badges);
  return el('article', { class: 'card', role: 'listitem' },
    m,
    favButton(item, ctx),
    el('div', { class: 'card-body' },
      el('h3', { class: 'card-title' },
        el('button', { class: 'card-hit', type: 'button', onclick: () => ctx.open(item) }, item.t)),
      el('div', { class: 'card-meta' }, metaLine(item)),
    ),
  );
}
