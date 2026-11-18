/// <reference lib="webworker" />
// Full-text search index, built off the main thread.
import MiniSearch from 'minisearch';

interface Doc {
  id: string;
  t: string;
  tg: string;
  c: string;
  s: string;
  f: string;
  cap: string;
  extra: string;
}

let index: MiniSearch<Doc> | null = null;

const SEARCH_OPTS = {
  prefix: true,
  fuzzy: (term: string) => (term.length > 4 ? 0.2 : false),
  boost: { t: 4, tg: 2.5, c: 2, s: 1.2, f: 1, extra: 1, cap: 0.4 },
};

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as
    | { type: 'index'; docs: string[][] }
    | { type: 'search'; id: number; q: string };
  if (msg.type === 'index') {
    index = new MiniSearch<Doc>({
      fields: ['t', 'tg', 'c', 's', 'f', 'cap', 'extra'],
      storeFields: [],
      processTerm: (term) => term.toLowerCase().replace(/[_\-.]+/g, ' ').trim() || null,
      tokenize: (text) => text.split(/[\s_\-.,;:!?()[\]{}"'#/\\|+]+/u),
    });
    const docs = msg.docs;
    // Add in slices and drop each source row once indexed, so peak memory stays low.
    for (let i = 0; i < docs.length; i++) {
      const [id, t, tg, c, s, f, cap, extra] = docs[i];
      index.add({ id, t, tg, c, s, f, cap, extra });
      (docs as unknown[])[i] = undefined;
    }
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'search' && index) {
    let results = index.search(msg.q, { ...SEARCH_OPTS, combineWith: 'AND' });
    if (results.length === 0) results = index.search(msg.q, { ...SEARCH_OPTS, combineWith: 'OR' });
    self.postMessage({ type: 'results', id: msg.id, ids: results.map((r) => r.id as string) });
  }
};
