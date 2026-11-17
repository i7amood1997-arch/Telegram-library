// Favorites and collections, stored in this browser only (the site has no server).
import { safeLocal, storage } from './dom';

export interface Collection {
  id: string;
  name: string;
  items: string[]; // newest added first
  created: number;
}

interface SavedState {
  v: 1;
  favorites: string[];
  collections: Collection[];
}

type Listener = () => void;

export class Saved {
  private state: SavedState;
  private listeners = new Set<Listener>();

  constructor(private readonly key: string) {
    this.state = Saved.parse(storage.get(safeLocal(), key)) ?? { v: 1, favorites: [], collections: [] };
    window.addEventListener('storage', (e) => {
      if (e.key !== this.key) return;
      const next = Saved.parse(e.newValue);
      if (next) { this.state = next; this.emit(); }
    });
  }

  static parse(raw: string | null): SavedState | null {
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as SavedState;
      if (!Array.isArray(s.favorites) || !Array.isArray(s.collections)) return null;
      return {
        v: 1,
        favorites: s.favorites.filter((x) => typeof x === 'string'),
        collections: s.collections
          .filter((c) => c && typeof c.name === 'string' && Array.isArray(c.items))
          .map((c) => ({ id: String(c.id || newId()), name: c.name.slice(0, 60), items: c.items.filter((x) => typeof x === 'string'), created: Number(c.created) || Date.now() })),
      };
    } catch {
      return null;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(): void {
    storage.set(safeLocal(), this.key, JSON.stringify(this.state));
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // Favorites -----------------------------------------------------------------------------------
  get favorites(): readonly string[] { return this.state.favorites; }
  isFavorite(id: string): boolean { return this.state.favorites.includes(id); }
  toggleFavorite(id: string): boolean {
    const on = !this.isFavorite(id);
    this.state.favorites = on ? [id, ...this.state.favorites] : this.state.favorites.filter((x) => x !== id);
    this.commit();
    return on;
  }

  // Collections ---------------------------------------------------------------------------------
  get collections(): readonly Collection[] { return this.state.collections; }
  collection(id: string): Collection | undefined { return this.state.collections.find((c) => c.id === id); }
  collectionsWith(itemId: string): Collection[] { return this.state.collections.filter((c) => c.items.includes(itemId)); }

  createCollection(name: string): Collection {
    const c: Collection = { id: newId(), name: name.trim().slice(0, 60) || 'Untitled collection', items: [], created: Date.now() };
    this.state.collections = [c, ...this.state.collections];
    this.commit();
    return c;
  }

  renameCollection(id: string, name: string): void {
    const c = this.collection(id);
    if (!c || !name.trim()) return;
    c.name = name.trim().slice(0, 60);
    this.commit();
  }

  deleteCollection(id: string): void {
    this.state.collections = this.state.collections.filter((c) => c.id !== id);
    this.commit();
  }

  toggleInCollection(id: string, itemId: string): boolean {
    const c = this.collection(id);
    if (!c) return false;
    const on = !c.items.includes(itemId);
    c.items = on ? [itemId, ...c.items] : c.items.filter((x) => x !== itemId);
    this.commit();
    return on;
  }

  // Transfer between devices ----------------------------------------------------------------------
  exportCode(): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(this.state))));
  }

  /** Merges an exported code into this device. Returns false when the code is not valid. */
  importCode(code: string): boolean {
    let incoming: SavedState | null = null;
    try {
      incoming = Saved.parse(decodeURIComponent(escape(atob(code.trim()))));
    } catch {
      incoming = null;
    }
    if (!incoming) return false;
    this.state.favorites = [...new Set([...this.state.favorites, ...incoming.favorites])];
    for (const c of incoming.collections) {
      const same = this.state.collections.find((x) => x.id === c.id || x.name === c.name);
      if (same) same.items = [...new Set([...same.items, ...c.items])];
      else this.state.collections.push(c);
    }
    this.commit();
    return true;
  }
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
