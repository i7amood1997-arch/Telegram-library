// Saved: favorites, collections, and moving them to another device.
import { type AppCtx, type View } from '../ctx';
import { el, icon } from '../dom';
import { VirtualGrid } from '../grid';
import { collectionsRow } from './home';

export function savedOverview(ctx: AppCtx, params?: URLSearchParams): View {
  const body = el('div', { class: 'saved-body' });
  const render = () => {
    const nameInput = el('input', { type: 'text', id: 'new-collection', class: 'text-input', placeholder: 'e.g. Riyadh villa project', maxlength: '60', 'aria-label': 'New collection name' });
    const form = el('form', { class: 'new-col' }, nameInput,
      el('button', { class: 'pill primary sm', type: 'submit' }, icon('plus', 16), 'Create'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) { nameInput.focus(); return; }
      const c = ctx.saved.createCollection(nameInput.value);
      ctx.toast(`Created “${c.name}”`);
    });
    body.replaceChildren(
      collectionsRow(ctx),
      el('section', { class: 'panel-box' },
        el('h2', {}, 'New collection'),
        el('p', { class: 'muted' }, 'Group models for a project, then open them all from one place.'),
        form),
      transferBox(ctx),
    );
  };
  render();
  const unsub = ctx.saved.subscribe(render);
  if (params?.get('new')) setTimeout(() => document.getElementById('new-collection')?.focus(), 80);
  const root = el('div', { class: 'view wrap saved' },
    el('header', { class: 'big-title' }, el('div', {},
      el('h1', {}, 'Saved'),
      el('p', { class: 'title-sub' }, `${ctx.saved.favorites.length} favorites · ${ctx.saved.collections.length} collections`))),
    body);
  return { el: root, destroy: unsub };
}

function transferBox(ctx: AppCtx): HTMLElement {
  const code = el('textarea', { id: 'import-code', class: 'text-input code-input', rows: '3', placeholder: 'Paste a code copied on another device', 'aria-label': 'Code from another device' });
  const copy = el('button', { class: 'pill secondary sm', type: 'button' }, icon('copy', 16), 'Copy code');
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
  const importBtn = el('button', { class: 'pill secondary sm', type: 'button' }, icon('download', 16), 'Import');
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
      titleRow.replaceChildren(el('h1', {}, 'Collection not found'));
      actions.replaceChildren(el('a', { class: 'pill secondary sm', href: '#/saved' }, icon('back', 16), 'All saved'));
      grid.setItems([]);
      return;
    }
    const ids = isFav ? ctx.saved.favorites : col!.items;
    const items = ids.map((id) => ctx.idx.byId.get(id)).filter((i) => i !== undefined);
    titleRow.replaceChildren(
      el('h1', {}, isFav ? 'Favorites' : col!.name),
      el('p', { class: 'title-sub' }, `${items.length} ${items.length === 1 ? 'model' : 'models'}`));
    if (col) {
      const rename = el('button', { class: 'pill secondary sm', type: 'button' }, icon('edit', 16), 'Rename');
      rename.addEventListener('click', () => {
        const input = el('input', { type: 'text', id: 'rename-collection', class: 'text-input', value: col.name, maxlength: '60', 'aria-label': 'Collection name' });
        const form = el('form', { class: 'inline-form' }, input,
          el('button', { class: 'pill primary sm', type: 'submit' }, 'Save'),
          el('button', { class: 'pill secondary sm', type: 'button', onclick: render }, 'Cancel'));
        form.addEventListener('submit', (e) => { e.preventDefault(); ctx.saved.renameCollection(col.id, input.value); });
        actions.replaceChildren(form);
        input.select();
      });
      const del = el('button', { class: 'pill secondary sm danger', type: 'button' }, icon('trash', 16), 'Delete');
      del.addEventListener('click', () => {
        actions.replaceChildren(
          el('span', { class: 'confirm-text' }, `Delete “${col.name}”? The models stay in the library.`),
          el('button', { class: 'pill danger-fill sm', type: 'button', onclick: () => { ctx.saved.deleteCollection(col.id); ctx.go('#/saved'); ctx.toast('Collection deleted'); } }, 'Delete'),
          el('button', { class: 'pill secondary sm', type: 'button', onclick: render }, 'Cancel'));
      });
      actions.replaceChildren(rename, del);
    } else {
      actions.replaceChildren();
    }
    empty.hidden = items.length > 0;
    empty.replaceChildren(icon(isFav ? 'heart' : 'folder', 36),
      el('h2', {}, isFav ? 'No favorites yet' : 'This collection is empty'),
      el('p', {}, isFav ? 'Tap the heart on any model to keep it here.' : 'Open a model and choose “Add to collection”.'),
      el('div', { class: 'empty-actions' }, el('a', { class: 'pill primary sm', href: '#/browse' }, 'Browse models')));
    grid.setItems(items);
  };
  render();
  const unsub = ctx.saved.subscribe(render);
  const root = el('div', { class: 'view wrap saved' },
    el('header', { class: 'big-title stack' },
      el('a', { class: 'link back', href: '#/saved' }, icon('back', 16), 'Saved'),
      titleRow, actions),
    empty, gridRoot);
  return { el: root, destroy: () => { unsub(); grid.destroy(); } };
}
