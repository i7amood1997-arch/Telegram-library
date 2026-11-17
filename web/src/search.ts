// Promise wrapper around the MiniSearch worker.
import type { Item } from './types';

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
    this.worker.postMessage({ type: 'index', items });
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
