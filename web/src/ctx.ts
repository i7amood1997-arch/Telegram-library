import type { CardContext } from './cards';
import type { Indexed } from './data';
import type { SearchIndex } from './search';
import type { Item } from './types';

export interface AppCtx extends CardContext {
  idx: Indexed;
  search: SearchIndex;
  /** Navigate to a hash route like "#/browse?cat=Tables". */
  go: (hash: string) => void;
  /** Update the current route's query without adding history. */
  replace: (hash: string) => void;
  toast: (message: string) => void;
  pickCollections: (item: Item) => void;
  updatedAt: number;
}

export interface View {
  el: HTMLElement;
  destroy?: () => void;
  /** Browse view only: live-update the search query from the header field. */
  setQuery?: (q: string) => void;
}

export const browseHref = (params: Record<string, string>): string => {
  const p = new URLSearchParams(params);
  const qs = p.toString();
  return `#/browse${qs ? `?${qs}` : ''}`;
};
