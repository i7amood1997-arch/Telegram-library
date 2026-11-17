// Virtualized responsive card grid: only rows near the viewport exist in the DOM.
import { card, type CardContext } from './cards';
import type { Item } from './types';

const BUFFER_PX = 900;
// Card = 4:3 preview + fixed text block. Phones get two columns.
const metrics = (width: number) =>
  width < 640 ? { min: 150, gap: 12, info: 58 } : { min: 250, gap: 22, info: 66 };

export class VirtualGrid {
  private items: Item[] = [];
  private cols = 1;
  private cardW = 0;
  private rowH = 1;
  private gap = 20;
  private rendered = new Map<number, HTMLElement>();
  private frame = 0;
  private readonly onScroll = () => this.schedule();
  private readonly observer: ResizeObserver;

  constructor(private readonly root: HTMLElement, private readonly ctx: CardContext) {
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(root);
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onScroll);
    this.observer.disconnect();
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
    if (!this.root.isConnected) return;
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
      const node = card(this.items[i], this.ctx);
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      node.style.position = 'absolute';
      node.style.transform = `translate(${col * (this.cardW + this.gap)}px, ${row * this.rowH}px)`;
      node.style.width = `${this.cardW}px`;
      node.style.height = `${this.rowH - this.gap}px`;
      this.rendered.set(i, node);
      frag.append(node);
    }
    this.root.append(frag);
  }
}
