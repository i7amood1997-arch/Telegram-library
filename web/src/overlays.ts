// Detail sheet, image lightbox, collection picker, share dialog and toasts.
import { card, favButton, preview } from './cards';
import { browseHref, type AppCtx } from './ctx';
import { similarItems } from './data';
import { edgeFade, el, formatDate, formatSize, icon, relativeTime } from './dom';
import type { Item, OwnerInfo } from './types';

/** A <dialog> that animates out before closing (Escape, backdrop and buttons all use it). */
function animatedDialog(cls: string, label: string) {
  const d = el('dialog', { class: cls, 'aria-label': label });
  const close = () => {
    if (!d.open || d.classList.contains('closing')) return;
    d.classList.add('closing');
    setTimeout(() => { d.classList.remove('closing'); d.close(); }, 260);
  };
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  document.body.append(d);
  return { d, close };
}

// ---------------------------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------------------------

export function createToaster(): (msg: string) => void {
  const box = el('div', { class: 'toast glass', role: 'status', 'aria-live': 'polite' });
  document.body.append(box);
  let t = 0;
  return (msg: string) => {
    box.textContent = msg;
    box.classList.add('on');
    window.clearTimeout(t);
    t = window.setTimeout(() => box.classList.remove('on'), 2400);
  };
}

// ---------------------------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------------------------

export function createLightbox(): (src: string, alt: string) => void {
  const { d, close } = animatedDialog('lightbox', 'Preview image');
  return (src, alt) => {
    const img = el('img', { src, alt });
    img.addEventListener('click', close);
    d.replaceChildren(img, el('button', { class: 'icon-btn lb-close glass', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 20)));
    d.showModal();
  };
}

// ---------------------------------------------------------------------------------------------
// Collection picker
// ---------------------------------------------------------------------------------------------

export function createCollectionPicker(ctx: () => AppCtx): (item: Item) => void {
  const { d, close } = animatedDialog('panel-dialog', 'Add to collection');
  return (item) => {
    const c = ctx();
    const render = () => {
      const input = el('input', { type: 'text', id: 'picker-new', class: 'text-input', placeholder: 'New collection name', maxlength: '60', 'aria-label': 'New collection name' });
      const form = el('form', { class: 'new-col' }, input, el('button', { class: 'pill primary sm', type: 'submit' }, 'Create'));
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
        return el('label', { class: 'opt', for: id }, el('span', { class: 'opt-label' }, col.name),
          el('span', { class: 'opt-count' }, String(col.items.length)), box, el('span', { class: 'tick', 'aria-hidden': 'true' }, icon('check', 16)));
      });
      d.replaceChildren(el('div', { class: 'pd-inner' },
        el('div', { class: 'pd-head' }, el('h2', {}, 'Add to Collection'),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18))),
        el('p', { class: 'muted' }, item.t),
        rows.length ? el('div', { class: 'group-list picker' }, rows) : el('p', { class: 'muted small' }, 'No collections yet. Create one for a project.'),
        form));
    };
    render();
    d.showModal();
  };
}

function fadeShelf(node: HTMLElement): HTMLElement {
  edgeFade(node);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------------------------

export function createDetail(ctx: () => AppCtx, lightbox: (src: string, alt: string) => void) {
  const { d, close } = animatedDialog('sheet', 'Model details');
  let onClose: (() => void) | null = null;
  d.addEventListener('close', () => { onClose?.(); });

  // Swipe down from the top of the sheet to dismiss it on touch screens.
  let y0: number | null = null;
  let dy = 0;
  d.addEventListener('touchstart', (e) => { if (d.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  d.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { d.style.transition = 'none'; d.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  d.addEventListener('touchend', () => {
    if (y0 === null) return;
    d.style.transition = '';
    d.style.transform = '';
    if (dy > 110) close();
    y0 = null;
  });

  function row(labelText: string, value: Node | string | null): HTMLElement | null {
    if (value === null || value === '') return null;
    return el('div', { class: 'row' }, el('span', {}, labelText), el('span', {}, value));
  }

  function open(item: Item, closed: () => void): void {
    const c = ctx();
    onClose = closed;
    const go = (href: string) => { onClose = null; d.close(); c.go(href); };
    const link = (text: string, href: string) => el('a', { href, onclick: (e: Event) => { e.preventDefault(); go(href); } }, text);

    let media: HTMLElement;
    if (item.th) {
      const src = c.thumbUrl(item.th);
      media = el('button', { class: 'd-img', type: 'button', 'aria-label': 'View full screen', onclick: () => lightbox(src, item.t) },
        preview(item, c, 'pv d-pv'), el('span', { class: 'zoomhint frost' }, icon('expand', 14), 'Full screen'));
    } else {
      media = el('div', { class: 'd-img' }, preview(item, c, 'pv d-pv'));
    }

    const fav = favButton(item, c, 'round');
    const inCols = c.saved.collectionsWith(item.id);
    const similar = similarItems(c.idx, item, 12);
    const simCtx = { ...c, open: (it: Item) => { onClose = null; open(it, closed); history.replaceState(history.state, '', `${location.pathname}${location.search}#/m/${encodeURIComponent(it.id)}`); } };

    const facts = [
      item.r !== 'Unknown' ? item.r : null,
      item.mv ? `3ds Max ${item.mv}` : null,
      formatSize(item.sz),
      item.f.length > 1 ? `${item.f.length} parts` : null,
      item.col ? 'Pack' : null,
    ].filter(Boolean) as string[];

    d.replaceChildren(...([
      el('div', { class: 'grabber', 'aria-hidden': 'true' }, el('i')),
      el('button', { class: 'icon-btn sheet-close glass', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 16)),
      el('div', { class: 'd-top' },
        media,
        el('div', { class: 'd-info' },
          el('nav', { class: 'crumb', 'aria-label': 'Category' }, link(item.g, browseHref({ g: item.g })), icon('chevron-right', 13), link(item.c, browseHref({ g: item.g, cat: item.c }))),
          el('h2', {}, item.t),
          el('div', { class: 'facts' }, facts.map((t) => el('span', { class: 'fact' }, t))),
          el('div', { class: 'actions' },
            el('a', { class: 'pill primary lg', href: item.l, target: '_blank', rel: 'noopener noreferrer' }, icon('send', 18), 'Open in Telegram'),
            fav),
          el('div', { class: 'group-list' },
            row('Style', item.s !== 'Other' ? link(item.s, browseHref({ style: item.s })) : 'Other'),
            row('Channel', c.idx.channelName.get(String(item.ch)) ?? ''),
            row('Posted', `${formatDate(item.d)} · ${relativeTime(item.d)}`),
            row('Materials', item.m.join(', ')),
            row('Colors', item.co.join(', '))),
          item.tg.length ? el('div', { class: 'tags' }, item.tg.map((t) => link(`#${t}`, browseHref({ q: t })))) : null,
          el('div', { class: 'group-list files' }, item.f.map(([name, size]) =>
            el('div', { class: 'row' }, el('span', {}, icon('file', 15), el('span', { class: 'fname' }, name)), el('span', {}, formatSize(size))))),
          el('div', { class: 'group-list' },
            el('button', { class: 'row action-row', type: 'button', onclick: () => c.pickCollections(item) },
              el('span', {}, inCols.length ? `In ${inCols.map((x) => x.name).join(', ')}` : 'Add to Collection…'), icon('chevron-right', 16)),
            el('button', { class: 'row action-row', type: 'button', onclick: async () => {
              try { await navigator.clipboard.writeText(item.l); c.toast('Telegram link copied'); } catch { c.toast('Could not copy the link'); }
            } }, el('span', {}, 'Copy Telegram Link'), icon('copy', 16))),
          item.cap ? el('details', { class: 'caption' }, el('summary', {}, 'Original post text'), el('p', { dir: 'auto' }, item.cap)) : null,
          item.p ? null : el('p', { class: 'muted small' }, 'Not categorized yet. Details may be incomplete.'),
        )),
      similar.length ? el('section', { class: 'd-similar' },
        el('div', { class: 'sec-head' }, el('h2', {}, 'You might also like'), link('See all', browseHref({ g: item.g, cat: item.c }))),
        fadeShelf(el('div', { class: 'shelf', role: 'list' }, similar.map((it) => card(it, simCtx))))) : null,
    ].filter(Boolean) as Node[]));
    if (!d.open) d.showModal();
    d.scrollTop = 0;
  }

  return {
    open,
    close: () => { onClose = null; if (d.open) d.close(); },
    get isOpen() { return d.open; },
  };
}

// ---------------------------------------------------------------------------------------------
// Share access (owner only)
// ---------------------------------------------------------------------------------------------

export function createShareDialog(owner: OwnerInfo): () => void {
  const { d, close } = animatedDialog('panel-dialog', 'Share access');
  const copyButton = (labelText: string, text: string) => {
    const b = el('button', { class: 'pill secondary sm', type: 'button' }, icon('copy', 15), labelText);
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.replaceChildren(icon('check', 15), 'Copied'); }
      catch { b.replaceChildren('Copy failed'); }
      setTimeout(() => b.replaceChildren(icon('copy', 15), labelText), 1600);
    });
    return b;
  };
  return () => {
    const site = `${location.origin}${location.pathname}`;
    d.replaceChildren(el('div', { class: 'pd-inner' },
      el('div', { class: 'pd-head' }, el('h2', {}, 'Share Access'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18))),
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
