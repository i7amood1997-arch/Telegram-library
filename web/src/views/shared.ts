import { browseHref } from '../ctx';
import type { Suggestion } from '../data';

export function suggestionHref(s: Suggestion): string {
  switch (s.kind) {
    case 'category': return browseHref({ g: s.group, cat: s.label });
    case 'style': return browseHref({ style: s.label });
    case 'tag': return browseHref({ q: s.label });
    default: return browseHref({ q: s.q });
  }
}
