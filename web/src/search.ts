// Promise wrapper around the MiniSearch worker.
import type { Item } from './types';

/** Only the start of a post's text is searchable; titles, tags and file names carry the rest. */
const CAPTION_SEARCH_CHARS = 140;

export class SearchIndex {
  readonly ready: Promise<void>;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, (ids: string[]) => void>();

  constructor(items: Item[]) {
    this.worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    let markReady: () => void = () => {};
    this.ready = new Promise((resolve) => { markReady = resolve; });
    this.worker.onmessage = (ev) => {
      const msg = ev.data as { type: string; id?: number; ids?: string[] };
      if (msg.type === 'ready') markReady();
      if (msg.type === 'results' && msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg.ids ?? []);
        this.pending.delete(msg.id);
      }
    };
    // Send only what search needs, as one compact string per field (not the whole items).
    const docs = items.map((it) => [
      it.id,
      it.t,
      it.tg.join(' '),
      `${it.c} ${it.g}`,
      `${it.s} ${it.r}`,
      it.f.map((f) => f[0]).join(' '),
      it.cap.slice(0, CAPTION_SEARCH_CHARS),
      it.m.length || it.co.length ? `${it.m.join(' ')} ${it.co.join(' ')}` : '',
    ]);
    this.worker.postMessage({ type: 'index', docs });
  }

  async search(q: string): Promise<string[]> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'search', id, q });
    });
  }
}
