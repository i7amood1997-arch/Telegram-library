// Model card: preview with depth tilt + sheen, glass heart, title and specs underneath.
import { el, formatSize, icon } from './dom';
import type { Saved } from './saved';
import type { Item } from './types';

export interface CardContext {
  thumbUrl: (name: string) => string;
  isNew: (item: Item) => boolean;
  saved: Saved;
  open: (item: Item) => void;
}

const canHover = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function metaLine(item: Item): string {
  const parts = [];
  if (item.g === 'Resources') parts.push(item.c);
  else if (item.r !== 'Unknown') parts.push(item.r);
  if (item.mv) parts.push(`Max ${item.mv}`);
  parts.push(formatSize(item.sz));
  return parts.join(' · ');
}

/** Subtle 3D tilt that follows the pointer, with a moving highlight. */
export function tilt(node: HTMLElement): void {
  if (!canHover || reduceMotion) return;
  node.addEventListener('pointermove', (e) => {
    const r = node.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    node.style.transform = `perspective(900px) rotateX(${(0.5 - py) * 7}deg) rotateY(${(px - 0.5) * 9}deg)`;
    node.style.setProperty('--mx', `${px * 100}%`);
    node.style.setProperty('--my', `${py * 100}%`);
  });
  node.addEventListener('pointerleave', () => { node.style.transform = ''; });
}

export function preview(item: Item, ctx: CardContext, cls = 'pv'): HTMLElement {
  const box = el('div', { class: cls });
  if (item.th) {
    const img = el('img', { src: ctx.thumbUrl(item.th), alt: '', decoding: 'async', draggable: 'false', loading: 'lazy' });
    img.addEventListener('load', () => img.classList.add('ready'), { once: true });
    img.addEventListener('error', () => box.classList.add('broken'), { once: true });
    box.append(img, el('span', { class: 'shimmer' }));
  } else {
    box.classList.add('empty');
    box.append(icon(item.g === 'Resources' ? 'layers' : 'cube', 34));
  }
  return box;
}

export function favButton(item: Item, ctx: CardContext, cls = 'heart glass'): HTMLButtonElement {
  const on = ctx.saved.isFavorite(item.id);
  const btn = el('button', {
    class: cls, type: 'button', 'data-fav': item.id, 'aria-pressed': String(on),
    'aria-label': on ? `Remove ${item.t} from Favorites` : `Add ${item.t} to Favorites`,
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
    b.setAttribute('aria-pressed', String(saved.isFavorite(b.dataset.fav!)));
  });
}

export function card(item: Item, ctx: CardContext): HTMLElement {
  const pv = preview(item, ctx, 'pv tilt');
  tilt(pv);
  const badges = el('div', { class: 'badges' },
    ctx.isNew(item) ? el('span', { class: 'badge glass' }, 'New') : null,
    item.col ? el('span', { class: 'badge glass' }, 'Pack') : null,
    item.f.length > 1 ? el('span', { class: 'badge glass' }, `${item.f.length} parts`) : null,
  );
  return el('article', { class: 'card', role: 'listitem' },
    pv,
    badges,
    favButton(item, ctx),
    el('div', { class: 'card-text' },
      el('h3', { class: 'card-title' },
        el('button', { class: 'card-hit', type: 'button', onclick: () => ctx.open(item) }, item.t)),
      el('p', { class: 'card-meta' }, metaLine(item)),
    ),
  );
}
