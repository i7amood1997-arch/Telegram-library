// Type-ahead suggestions under a search field: categories, styles and tags.
import { type Indexed, type Suggestion, suggest } from './data';
import { el, icon } from './dom';

let counter = 0;

export function attachSuggest(
  input: HTMLInputElement,
  idx: Indexed,
  onPick: (s: Suggestion) => void,
): void {
  const listId = `suggest-${++counter}`;
  const list = el('ul', { class: 'suggest', id: listId, role: 'listbox', hidden: true });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  let options: Suggestion[] = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (i: number) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${listId}-${i}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const pick = (s: Suggestion) => {
    close();
    onPick(s);
  };

  const render = () => {
    // The field may not be in the page yet when this is wired up, so attach on first use.
    if (!list.isConnected) input.parentElement?.append(list);
    options = suggest(idx, input.value);
    if (options.length <= 1 && !input.value.trim()) { close(); return; }
    list.replaceChildren(...options.map((s, i) => {
      const [ico, hint] = s.kind === 'search' ? ['search', 'Search all models']
        : s.kind === 'category' ? ['grid', `${s.group} · ${s.count.toLocaleString('en')}`]
          : s.kind === 'style' ? ['layers', `Style · ${s.count.toLocaleString('en')}`]
            : ['tag', `Tag · ${s.count.toLocaleString('en')}`];
      const li = el('li', { id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false', class: `sg sg-${s.kind}` },
        icon(ico, 16),
        el('span', { class: 'sg-label' }, s.kind === 'search' ? `“${s.label}”` : s.label),
        el('span', { class: 'sg-hint' }, hint));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(s); });
      return li;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && e.key !== 'Enter') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(options.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(-1, active - 1)); }
    else if (e.key === 'Escape') { close(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const s = active >= 0 ? options[active] : null;
      if (s) pick(s);
      else if (input.value.trim()) pick({ kind: 'search', label: input.value.trim(), q: input.value.trim() });
      else close();
    }
  });
}
