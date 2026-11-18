// Library indexes, filtering, similar models and search suggestions (pure, no DOM).
import type { Added, FacetKey, Filters, Item, Library, Sort } from './types';

export const GROUP_ORDER = ['Interior', 'Exterior', 'Scenes', 'Resources'];

export const FACETS: { key: FacetKey; label: string; param: string }[] = [
  { key: 'cat', label: 'Category', param: 'cat' },
  { key: 'style', label: 'Style', param: 'style' },
  { key: 'engine', label: 'Render engine', param: 'engine' },
  { key: 'version', label: '3ds Max version', param: 'max' },
  { key: 'channel', label: 'Channel', param: 'ch' },
];

export const ADDED: { value: Added; label: string; seconds: number }[] = [
  { value: '', label: 'Any time', seconds: 0 },
  { value: '1d', label: 'Last 24 hours', seconds: 86400 },
  { value: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
  { value: '30d', label: 'Last 30 days', seconds: 30 * 86400 },
];

export const SORTS: { value: Sort; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'new', label: 'Newest' },
  { value: 'old', label: 'Oldest' },
  { value: 'title', label: 'Name A–Z' },
  { value: 'size', label: 'Largest' },
];

export interface CategoryInfo {
  name: string;
  group: string;
  count: number;
  cover: Item | null; // newest item with a preview
}

export interface Indexed {
  lib: Library;
  items: Item[]; // newest first
  byId: Map<string, Item>;
  channelName: Map<string, string>;
  groups: string[];
  categories: Map<string, CategoryInfo>;
  categoriesByGroup: Map<string, CategoryInfo[]>;
  styleCounts: Map<string, number>;
  tagCounts: [string, number][]; // most used first
}

const EMPTY: string[] = Object.freeze([]) as unknown as string[];

/** The payload leaves out empty fields to save memory on phones; fill them in (shared empties). */
function normalize(it: Item): void {
  it.tg ??= EMPTY;
  it.m ??= EMPTY;
  it.co ??= EMPTY;
  it.cap ??= '';
  it.mv ??= null;
  it.th ??= null;
  it.col ??= false;
  it.p ??= it.g !== 'Uncategorized';
}

export function indexLibrary(lib: Library): Indexed {
  for (const it of lib.items) normalize(it);
  const items = lib.items.sort((a, b) => b.d - a.d);
  const byId = new Map(items.map((i) => [i.id, i]));
  const channelName = new Map(lib.channels.map((c) => [String(c.id), c.title || `Channel ${c.id}`]));
  const categories = new Map<string, CategoryInfo>();
  const styleCounts = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const it of items) {
    let c = categories.get(it.c);
    if (!c) {
      c = { name: it.c, group: it.g, count: 0, cover: null };
      categories.set(it.c, c);
    }
    c.count += 1;
    if (!c.cover && it.th) c.cover = it;
    styleCounts.set(it.s, (styleCounts.get(it.s) ?? 0) + 1);
    for (const t of it.tg) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  const groups = [...GROUP_ORDER.filter((g) => items.some((i) => i.g === g)),
    ...[...new Set(items.map((i) => i.g))].filter((g) => !GROUP_ORDER.includes(g))];
  const categoriesByGroup = new Map<string, CategoryInfo[]>();
  for (const g of groups) {
    const order = lib.taxonomy.categories[g] ?? [];
    const list = [...categories.values()].filter((c) => c.group === g);
    list.sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.count - a.count;
    });
    categoriesByGroup.set(g, list);
  }
  const tagCounts = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4000);
  return { lib, items, byId, channelName, groups, categories, categoriesByGroup, styleCounts, tagCounts };
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export function emptyFilters(): Filters {
  const facets = {} as Filters['facets'];
  for (const f of FACETS) facets[f.key] = new Set();
  return { q: '', group: '', facets, added: '', thumb: false, sort: 'relevance' };
}

export function filtersFromParams(p: URLSearchParams): Filters {
  const f = emptyFilters();
  f.q = p.get('q') ?? '';
  f.group = p.get('g') ?? '';
  for (const def of FACETS) {
    f.facets[def.key] = new Set((p.get(def.param) ?? '').split('|').filter(Boolean));
  }
  const added = (p.get('added') ?? '') as Added;
  f.added = ADDED.some((a) => a.value === added) ? added : '';
  f.thumb = p.get('preview') === '1';
  const sort = (p.get('sort') ?? '') as Sort;
  f.sort = SORTS.some((s) => s.value === sort) ? sort : 'relevance';
  return f;
}

export function filtersToParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.group) p.set('g', f.group);
  for (const def of FACETS) if (f.facets[def.key].size) p.set(def.param, [...f.facets[def.key]].join('|'));
  if (f.added) p.set('added', f.added);
  if (f.thumb) p.set('preview', '1');
  if (f.sort !== 'relevance') p.set('sort', f.sort);
  return p;
}

export function facetValue(item: Item, key: FacetKey): string {
  switch (key) {
    case 'cat': return item.c;
    case 'style': return item.s;
    case 'engine': return item.r;
    case 'version': return item.mv ?? 'Unknown';
    case 'channel': return String(item.ch);
  }
}

type Except = FacetKey | 'group' | 'added' | 'thumb' | null;

export function passes(item: Item, f: Filters, except: Except, now: number): boolean {
  if (except !== 'group' && f.group && item.g !== f.group) return false;
  for (const def of FACETS) {
    if (def.key === except) continue;
    const sel = f.facets[def.key];
    if (sel.size && !sel.has(facetValue(item, def.key))) return false;
  }
  if (except !== 'added' && f.added) {
    const secs = ADDED.find((a) => a.value === f.added)!.seconds;
    if (item.d < now - secs) return false;
  }
  if (except !== 'thumb' && f.thumb && !item.th) return false;
  return true;
}

export function applyFilters(base: Item[], f: Filters, ranked: boolean): Item[] {
  const now = Date.now() / 1000;
  const out = base.filter((i) => passes(i, f, null, now));
  const sort = f.sort === 'relevance' && !ranked ? 'new' : f.sort;
  switch (sort) {
    case 'new': out.sort((a, b) => b.d - a.d); break;
    case 'old': out.sort((a, b) => a.d - b.d); break;
    case 'title': out.sort((a, b) => a.t.localeCompare(b.t)); break;
    case 'size': out.sort((a, b) => b.sz - a.sz); break;
    default: break;
  }
  return out;
}

export function facetCounts(base: Item[], f: Filters, key: FacetKey | 'group'): Map<string, number> {
  const now = Date.now() / 1000;
  const counts = new Map<string, number>();
  for (const it of base) {
    if (!passes(it, f, key, now)) continue;
    const v = key === 'group' ? it.g : facetValue(it, key);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

export function activeFilterCount(f: Filters): number {
  return FACETS.reduce((n, d) => n + f.facets[d.key].size, 0) + (f.added ? 1 : 0) + (f.thumb ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Similar models: same category, ranked by shared tags, style and engine.
// ---------------------------------------------------------------------------------------------

export function similarItems(idx: Indexed, item: Item, limit = 12): Item[] {
  const tags = new Set(item.tg);
  const mats = new Set(item.m);
  const scored: [number, Item][] = [];
  for (const other of idx.items) {
    if (other.id === item.id || other.c !== item.c) continue;
    let score = 0;
    for (const t of other.tg) if (tags.has(t)) score += 3;
    for (const m of other.m) if (mats.has(m)) score += 1;
    if (other.s === item.s && item.s !== 'Other') score += 2;
    if (other.r === item.r && item.r !== 'Unknown') score += 0.5;
    if (other.th) score += 0.5;
    scored.push([score, other]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1].d - a[1].d);
  return scored.slice(0, limit).map(([, it]) => it);
}

// ---------------------------------------------------------------------------------------------
// Search suggestions
// ---------------------------------------------------------------------------------------------

export type Suggestion =
  | { kind: 'search'; label: string; q: string }
  | { kind: 'category'; label: string; group: string; count: number }
  | { kind: 'style'; label: string; count: number }
  | { kind: 'tag'; label: string; count: number };

function rank(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s&/-]+/).some((w) => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  return -1;
}

export function suggest(idx: Indexed, raw: string): Suggestion[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const out: Suggestion[] = [{ kind: 'search', label: raw.trim(), q: raw.trim() }];
  const cats = [...idx.categories.values()]
    .map((c) => [rank(c.name, q), c] as const)
    .filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0] || b[1].count - a[1].count)
    .slice(0, 4);
  for (const [, c] of cats) out.push({ kind: 'category', label: c.name, group: c.group, count: c.count });
  const styles = [...idx.styleCounts.entries()]
    .filter(([s]) => s !== 'Other' && rank(s, q) >= 0 && rank(s, q) <= 2)
    .slice(0, 2);
  for (const [s, n] of styles) out.push({ kind: 'style', label: s, count: n });
  const tags: Suggestion[] = [];
  for (const [t, n] of idx.tagCounts) {
    const r = rank(t, q);
    if (r < 0 || r > 2 || t === q) continue;
    tags.push({ kind: 'tag', label: t, count: n });
    if (tags.length >= 6) break;
  }
  out.push(...tags);
  return out;
}
