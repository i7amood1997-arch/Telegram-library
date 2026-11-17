// Virtualized responsive card grid: only rows near the viewport exist in the DOM.
import { el, formatSize, icon, relativeTime } from './dom';
import type { Item } from './types';

const BUFFER_PX = 800;
// Narrow screens get smaller cards so phones show two columns.
const metrics = (width: number) =>
  width < 640 ? { min: 150, gap: 10, info: 92 } : { min: 220, gap: 16, info: 96 };

export class VirtualGrid {
  private items: Item[] = [];
  private cols = 1;
  private cardW = 0;
  private rowH = 1;
  private gap = 16;
  private rendered = new Map<number, HTMLElement>();
  private frame = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly thumbUrl: (name: string) => string,
    private readonly isNew: (item: Item) => boolean,
    private readonly onOpen: (item: Item) => void,
  ) {
    window.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.layout()).observe(root);
  }

  setItems(items: Item[]): void {
    this.items = items;
    this.clear();
    this.layout();
  }

  private clear(): void {
    for (const node of this.rendered.values()) node.remove();
    this.rendered.clear();
  }

  private layout(): void {
    const width = this.root.clientWidth;
    if (!width) return;
    const { min, gap, info } = metrics(width);
    const cols = Math.max(1, Math.floor((width + gap) / (min + gap)));
    const cardW = (width - gap * (cols - 1)) / cols;
    const changed = cols !== this.cols || Math.abs(cardW - this.cardW) > 0.5;
    this.cols = cols;
    this.cardW = cardW;
    this.gap = gap;
    this.rowH = Math.round(cardW * 0.75) + info + gap;
    const rows = Math.ceil(this.items.length / cols);
    this.root.style.height = `${Math.max(0, rows * this.rowH - gap)}px`;
    if (changed) this.clear();
    this.render();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const top = -this.root.getBoundingClientRect().top;
    const firstRow = Math.max(0, Math.floor((top - BUFFER_PX) / this.rowH));
    const lastRow = Math.floor((top + window.innerHeight + BUFFER_PX) / this.rowH);
    const start = firstRow * this.cols;
    const end = Math.min(this.items.length, (lastRow + 1) * this.cols);

    for (const [idx, node] of this.rendered) {
      if (idx < start || idx >= end) {
        node.remove();
        this.rendered.delete(idx);
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const node = this.card(this.items[i]);
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      node.style.transform = `translate(${col * (this.cardW + this.gap)}px, ${row * this.rowH}px)`;
      node.style.width = `${this.cardW}px`;
      node.style.height = `${this.rowH - this.gap}px`;
      this.rendered.set(i, node);
      frag.append(node);
    }
    this.root.append(frag);
  }

  private card(item: Item): HTMLElement {
    const media = el('div', { class: 'card-media' });
    if (item.th) {
      const img = el('img', {
        src: this.thumbUrl(item.th), alt: item.t, decoding: 'async', draggable: 'false',
      });
      img.addEventListener('load', () => media.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => media.classList.add('broken'), { once: true });
      media.append(img);
    } else {
      media.classList.add('empty');
      media.append(icon('cube', 40));
    }
    const badges = el('div', { class: 'card-badges' },
      this.isNew(item) ? el('span', { class: 'badge badge-new' }, 'NEW') : null,
      item.col ? el('span', { class: 'badge' }, 'PACK') : null,
      item.f.length > 1 ? el('span', { class: 'badge' }, `${item.f.length} parts`) : null,
    );
    media.append(badges);

    return el('button', {
      class: 'card', type: 'button', 'data-id': item.id,
      'aria-label': `${item.t}, ${item.c}`,
      onclick: () => this.onOpen(item),
    },
      media,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-title' }, item.t),
        el('div', { class: 'card-meta' },
          el('span', { class: 'card-cat' }, item.c),
          el('span', { class: 'dot' }, '·'),
          el('span', {}, formatSize(item.sz)),
          el('span', { class: 'card-date' }, relativeTime(item.d)),
        ),
        el('div', { class: 'card-tags' }, item.tg.slice(0, 3).map((t) => el('span', { class: 'tag' }, t))),
      ),
    );
  }
}
