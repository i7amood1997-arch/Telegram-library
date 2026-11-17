export interface Item {
  id: string;
  /** title */ t: string;
  /** group (Interior / Exterior / Scenes / Uncategorized) */ g: string;
  /** category */ c: string;
  /** style */ s: string;
  /** render engine */ r: string;
  /** 3ds Max version */ mv: string | null;
  /** tags */ tg: string[];
  /** materials */ m: string[];
  /** colors */ co: string[];
  /** is a collection/pack */ col: boolean;
  /** classified by AI (false = fallback) */ p: boolean;
  /** files: [name, size] */ f: [string, number][];
  /** total size in bytes */ sz: number;
  /** caption */ cap: string;
  /** posted at (unix seconds) */ d: number;
  /** channel id */ ch: number;
  /** Telegram deep link */ l: string;
  /** thumbnail file name */ th: string | null;
}

export interface Taxonomy {
  version: number;
  categories: Record<string, string[]>;
  styles: string[];
  render_engines: string[];
}

export interface Library {
  format: number;
  updated_at: number;
  taxonomy: Taxonomy;
  channels: { id: number; title: string }[];
  items: Item[];
}

export type FacetKey = 'cat' | 'style' | 'engine' | 'version' | 'channel';
export type Added = '' | '1d' | '7d' | '30d';
export type Sort = 'relevance' | 'new' | 'old' | 'title' | 'size';

export interface Filters {
  q: string;
  facets: Record<FacetKey, Set<string>>;
  added: Added;
  thumb: boolean;
  sort: Sort;
}

export interface OwnerInfo {
  guests: { name: string; password: string; created: number }[];
  secret_guests: number;
}
