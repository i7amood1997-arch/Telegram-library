// Detail sheet, image lightbox, collection picker, share dialog and toasts.
import { card, favButton, metaLine } from './cards';
import { browseHref, type AppCtx } from './ctx';
import { similarItems } from './data';
import { el, formatDate, formatSize, icon, relativeTime } from './dom';
import type { Item, OwnerInfo } from './types';

function dialog(cls: string, label: string): HTMLDialogElement {
  const d = el('dialog', { class: cls, 'aria-label': label });
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d);
  return d;
}

// ---------------------------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------------------------

export function createToaster(): (msg: string) => void {
  const box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });
  document.body.append(box);
  let t = 0;
  return (msg: string) => {
    box.textContent = msg;
    box.hidden = false;
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    window.clearTimeout(t);
    t = window.setTimeout(() => { box.hidden = true; }, 2600);
  };
}

// ---------------------------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------------------------

export function createLightbox(): (src: string, alt: string) => void {
  const d = dialog('lightbox', 'Preview image');
  return (src, alt) => {
    d.replaceChildren(
      el('img', { src, alt }),
      el('button', { class: 'icon-btn lb-close', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, icon('close', 22)));
    d.querySelector('img')!.addEventListener('click', () => d.close());
    d.showModal();
  };
}

// ---------------------------------------------------------------------------------------------
// Collection picker
// ---------------------------------------------------------------------------------------------

export function createCollectionPicker(ctx: () => AppCtx): (item: Item) => void {
  const d = dialog('picker', 'Add to collection');
  return (item) => {
    const c = ctx();
    const render = () => {
      const input = el('input', { type: 'text', id: 'picker-new', class: 'text-input', placeholder: 'New collection name', maxlength: '60', 'aria-label': 'New collection name' });
      const form = el('form', { class: 'new-col' }, input, el('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus', 16), 'Create'));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        const col = c.saved.createCollection(input.value);
        c.saved.toggleInCollection(col.id, item.id);
        c.toast(`Added to “${col.name}”`);
        render();
      });
      const rows = c.saved.collections.map((col) => {
        const id = `pick-${col.id}`;
        const box = el('input', { type: 'checkbox', id, checked: col.items.includes(item.id) });
        box.addEventListener('change', () => {
          const on = c.saved.toggleInCollection(col.id, item.id);
          c.toast(on ? `Added to “${col.name}”` : `Removed from “${col.name}”`);
        });
        return el('label', { class: 'opt', for: id }, box, el('span', { class: 'opt-label' }, col.name),
          el('span', { class: 'opt-count' }, String(col.items.length)));
      });
      d.replaceChildren(el('div', { class: 'picker-inner' },
        el('div', { class: 'dlg-head' }, el('h2', {}, 'Add to collection'),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, icon('close'))),
        el('p', { class: 'muted picker-item' }, item.t),
        rows.length ? el('div', { class: 'picker-list' }, rows) : el('p', { class: 'muted' }, 'No collections yet. Create one for a project.'),
        form));
    };
    render();
    d.showModal();
  };
}

// ---------------------------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------------------------

export function createDetail(ctx: () => AppCtx, lightbox: (src: string, alt: string) => void) {
  const d = dialog('detail', 'Model details');
  let onClose: (() => void) | null = null;
  d.addEventListener('close', () => { onClose?.(); });

  function row(label: string, value: Node | string | null): HTMLElement | null {
    if (value === null || value === '') return null;
    return el('div', { class: 'info-row' }, el('dt', {}, label), el('dd', {}, value));
  }

  function open(item: Item, closed: () => void): void {
    const c = ctx();
    onClose = closed;
    const go = (href: string) => { onClose = null; d.close(); c.go(href); };
    const link = (text: string, href: string) => el('a', { href, onclick: (e: Event) => { e.preventDefault(); go(href); } }, text);

    const mediaBox = el('div', { class: 'detail-media' });
    if (item.th) {
      const src = c.thumbUrl(item.th);
      const img = el('img', { src, alt: item.t });
      const zoom = el('button', { class: 'zoom', type: 'button', 'aria-label': 'View full screen' }, img,
        el('span', { class: 'zoom-hint' }, icon('expand', 16), 'Full screen'));
      zoom.addEventListener('click', () => lightbox(src, item.t));
      mediaBox.append(zoom);
    } else {
      mediaBox.append(el('div', { class: 'no-preview' }, icon(item.g === 'Resources' ? 'layers' : 'cube', 48), 'No preview image'));
    }

    const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, icon('copy', 16), 'Copy link');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(item.l); c.toast('Telegram link copied'); } catch { c.toast('Could not copy the link'); }
    });
    const fav = favButton(item, c);
    fav.classList.add('fav-inline');
    const inCols = c.saved.collectionsWith(item.id);
    const colBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => c.pickCollections(item) },
      icon('folder', 16), inCols.length ? `In ${inCols.length} ${inCols.length === 1 ? 'collection' : 'collections'}` : 'Add to collection');

    const similar = similarItems(c.idx, item, 12);
    const simCtx = { ...c, open: (it: Item) => { onClose = null; open(it, closed); history.replaceState(history.state, '', `${location.pathname}${location.search}#/m/${encodeURIComponent(it.id)}`); } };

    d.replaceChildren(el('div', { class: 'detail-inner' },
      el('button', { class: 'icon-btn detail-close', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, icon('close')),
      el('div', { class: 'detail-top' },
        mediaBox,
        el('div', { class: 'detail-info' },
          el('nav', { class: 'crumbs' }, link(item.g, browseHref({ g: item.g })), el('span', { class: 'sep' }, '/'),
            link(item.c, browseHref({ g: item.g, cat: item.c }))),
          el('h2', { class: 'detail-title' }, item.t),
          el('p', { class: 'detail-meta' }, metaLine(item)),
          el('div', { class: 'detail-actions' },
            el('a', { class: 'btn btn-primary btn-lg', href: item.l, target: '_blank', rel: 'noopener noreferrer' }, icon('send', 17), 'Open in Telegram'),
            fav),
          el('div', { class: 'detail-actions secondary' }, colBtn, copyBtn),
          item.tg.length ? el('div', { class: 'tag-list' }, item.tg.map((t) => el('a', { class: 'tag', href: browseHref({ q: t }), onclick: (e: Event) => { e.preventDefault(); go(browseHref({ q: t })); } }, t))) : null,
          el('dl', { class: 'info' },
            row('Style', item.s !== 'Other' ? link(item.s, browseHref({ style: item.s })) : 'Other'),
            row('Render engine', item.r),
            row('3ds Max', item.mv ?? 'Not stated'),
            row('Channel', c.idx.channelName.get(String(item.ch)) ?? ''),
            row('Posted', `${formatDate(item.d)} · ${relativeTime(item.d)}`),
            row('Materials', item.m.join(', ')),
            row('Colors', item.co.join(', '))),
          el('div', { class: 'files' },
            el('h3', {}, item.f.length > 1 ? `Files (${item.f.length})` : 'File'),
            el('ul', {}, item.f.map(([name, size]) => el('li', {}, icon('file', 15), el('span', { class: 'file-name' }, name), el('span', { class: 'file-size' }, formatSize(size)))))),
          item.cap ? el('details', { class: 'caption' }, el('summary', {}, 'Original post text'), el('p', { dir: 'auto' }, item.cap)) : null,
          item.p ? null : el('p', { class: 'muted small' }, 'Not categorized yet. Details may be incomplete.'),
        )),
      similar.length ? el('section', { class: 'similar' },
        el('div', { class: 'block-head' }, el('h2', {}, `More ${item.c.toLowerCase()}`),
          link('See all', browseHref({ g: item.g, cat: item.c }))),
        el('div', { class: 'row-scroll', role: 'list' }, similar.map((it) => card(it, simCtx)))) : null,
    ));
    if (!d.open) d.showModal();
    d.scrollTop = 0;
  }

  return {
    open,
    close: () => { onClose = null; if (d.open) d.close(); },
    refresh: (item: Item) => { if (d.open && onClose) open(item, onClose); },
    get isOpen() { return d.open; },
  };
}

// ---------------------------------------------------------------------------------------------
// Share access (owner only)
// ---------------------------------------------------------------------------------------------

export function createShareDialog(owner: OwnerInfo): () => void {
  const d = dialog('share', 'Share access');
  const copyButton = (labelText: string, text: string) => {
    const b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('copy', 15), labelText);
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.replaceChildren(icon('check', 15), 'Copied'); }
      catch { b.replaceChildren('Copy failed'); }
      setTimeout(() => b.replaceChildren(icon('copy', 15), labelText), 1600);
    });
    return b;
  };
  return () => {
    const site = `${location.origin}${location.pathname}`;
    d.replaceChildren(el('div', { class: 'share-inner' },
      el('div', { class: 'dlg-head' }, el('h2', {}, 'Share access'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, icon('close'))),
      el('p', { class: 'muted' }, 'Guests can browse and search the library. Only you can see this list.'),
      owner.guests.length ? el('ul', { class: 'guest-list' }, owner.guests.map((g) => el('li', { class: 'guest' },
        el('div', { class: 'guest-head' }, el('strong', {}, g.name), el('span', { class: 'muted small' }, `added ${relativeTime(g.created)}`)),
        el('code', { class: 'guest-pw' }, g.password),
        el('div', { class: 'guest-actions' },
          copyButton('Copy password', g.password),
          copyButton('Copy invite', `Model Library\n${site}\nPassword: ${g.password}`)))))
        : el('p', { class: 'empty-note' }, 'No guests yet.'),
      owner.secret_guests ? el('p', { class: 'muted small' }, `${owner.secret_guests} more guest password(s) are set in the GUEST_PASSWORDS secret.`) : null,
      el('p', { class: 'muted small' }, 'To add or remove a guest, run the “Sync library” workflow with mode add-guest or remove-guest and the guest’s name.')));
    d.showModal();
  };
}
