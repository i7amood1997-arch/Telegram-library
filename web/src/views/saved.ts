// Saved: favorites, collections, and moving them to another device.
import { type AppCtx, type View } from '../ctx';
import { el, icon } from '../dom';
import { VirtualGrid } from '../grid';
import { collectionTile } from './home';

export function savedOverview(ctx: AppCtx): View {
  const body = el('div', { class: 'saved-body' });
  const render = () => {
    const cols = ctx.saved.collections;
    const nameInput = el('input', { type: 'text', id: 'new-collection', class: 'text-input', placeholder: 'e.g. Riyadh villa project', maxlength: '60', 'aria-label': 'New collection name' });
    const form = el('form', { class: 'new-col' }, nameInput,
      el('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus', 16), 'Create'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) { nameInput.focus(); return; }
      const c = ctx.saved.createCollection(nameInput.value);
      ctx.toast(`Created “${c.name}”`);
    });
    body.replaceChildren(
      el('div', { class: 'col-grid' },
        collectionTile(ctx, 'Favorites', ctx.saved.favorites, '#/saved/fav', true),
        cols.map((c) => collectionTile(ctx, c.name, c.items, `#/saved/${c.id}`, false))),
      el('section', { class: 'panel-box' },
        el('h2', {}, 'New collection'),
        el('p', { class: 'muted' }, 'Group models for a project, then open them all from one place.'),
        form),
      transferBox(ctx),
    );
  };
  render();
  const unsub = ctx.saved.subscribe(render);
  const root = el('div', { class: 'page saved' },
    el('header', { class: 'browse-head' },
      el('nav', { class: 'crumbs' }, el('a', { href: '#/' }, 'Home'), el('span', { class: 'sep' }, '/'), el('span', {}, 'Saved')),
      el('div', { class: 'title-row' }, el('h1', { class: 'browse-title' }, 'Saved'))),
    body);
  return { el: root, destroy: unsub };
}

function transferBox(ctx: AppCtx): HTMLElement {
  const code = el('textarea', { id: 'import-code', class: 'text-input code-input', rows: '3', placeholder: 'Paste a code copied on another device', 'aria-label': 'Code from another device' });
  const copy = el('button', { class: 'btn btn-ghost', type: 'button' }, icon('copy', 16), 'Copy code');
  copy.addEventListener('click', async () => {
    const value = ctx.saved.exportCode();
    try {
      await navigator.clipboard.writeText(value);
      ctx.toast('Code copied. Paste it on your other device.');
    } catch {
      code.value = value;
      code.select();
      ctx.toast('Copy the selected code manually.');
    }
  });
  const importBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, icon('download', 16), 'Import');
  importBtn.addEventListener('click', () => {
    if (!code.value.trim()) { code.focus(); return; }
    if (ctx.saved.importCode(code.value)) { code.value = ''; ctx.toast('Saved models imported.'); }
    else ctx.toast('That code is not valid. Copy it again on the other device.');
  });
  return el('section', { class: 'panel-box' },
    el('h2', {}, 'Use on another device'),
    el('p', { class: 'muted' }, 'Favorites and collections are stored in this browser. Copy the code here and import it on your phone or another computer.'),
    el('div', { class: 'transfer' }, copy, code, importBtn));
}

export function savedListView(ctx: AppCtx, which: string): View {
  const isFav = which === 'fav';
  const gridRoot = el('div', { class: 'grid', role: 'list' });
  const grid = new VirtualGrid(gridRoot, ctx);
  const titleRow = el('div', { class: 'title-row' });
  const actions = el('div', { class: 'col-actions' });
  const empty = el('div', { class: 'empty', hidden: true });

  const render = () => {
    const col = isFav ? null : ctx.saved.collection(which);
    if (!isFav && !col) {
      titleRow.replaceChildren(el('h1', { class: 'browse-title' }, 'Collection not found'));
      actions.replaceChildren(el('a', { class: 'btn btn-ghost', href: '#/saved' }, icon('back', 16), 'All saved'));
      grid.setItems([]);
      return;
    }
    const ids = isFav ? ctx.saved.favorites : col!.items;
    const items = ids.map((id) => ctx.idx.byId.get(id)).filter((i) => i !== undefined);
    titleRow.replaceChildren(
      el('h1', { class: 'browse-title' }, isFav ? 'Favorites' : col!.name),
      el('p', { class: 'browse-count' }, `${items.length} ${items.length === 1 ? 'model' : 'models'}`));
    if (col) {
      const rename = el('button', { class: 'btn btn-ghost', type: 'button' }, icon('edit', 16), 'Rename');
      rename.addEventListener('click', () => {
        const input = el('input', { type: 'text', id: 'rename-collection', class: 'text-input', value: col.name, maxlength: '60', 'aria-label': 'Collection name' });
        const form = el('form', { class: 'inline-form' }, input,
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: render }, 'Cancel'));
        form.addEventListener('submit', (e) => { e.preventDefault(); ctx.saved.renameCollection(col.id, input.value); });
        actions.replaceChildren(form);
        input.select();
      });
      const del = el('button', { class: 'btn btn-ghost danger', type: 'button' }, icon('trash', 16), 'Delete');
      del.addEventListener('click', () => {
        actions.replaceChildren(
          el('span', { class: 'confirm-text' }, `Delete “${col.name}”? The models stay in the library.`),
          el('button', { class: 'btn btn-danger', type: 'button', onclick: () => { ctx.saved.deleteCollection(col.id); ctx.go('#/saved'); ctx.toast('Collection deleted'); } }, 'Delete'),
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: render }, 'Cancel'));
      });
      actions.replaceChildren(rename, del);
    } else {
      actions.replaceChildren();
    }
    empty.hidden = items.length > 0;
    empty.replaceChildren(icon(isFav ? 'heart' : 'folder', 36),
      el('h2', {}, isFav ? 'No favorites yet' : 'This collection is empty'),
      el('p', {}, isFav ? 'Tap the heart on any model to keep it here.' : 'Open a model and choose “Add to collection”.'),
      el('div', { class: 'empty-actions' }, el('a', { class: 'btn btn-primary', href: '#/browse' }, 'Browse models')));
    grid.setItems(items);
  };
  render();
  const unsub = ctx.saved.subscribe(render);
  const root = el('div', { class: 'page saved' },
    el('header', { class: 'browse-head' },
      el('nav', { class: 'crumbs' }, el('a', { href: '#/' }, 'Home'), el('span', { class: 'sep' }, '/'), el('a', { href: '#/saved' }, 'Saved')),
      titleRow, actions),
    empty, gridRoot);
  return { el: root, destroy: () => { unsub(); grid.destroy(); } };
}
