/* recipecard - browser side: collect input, render the card, let you edit it. */

const CATEGORIES = [
  'produce', 'meat & fish', 'dairy & eggs', 'bakery', 'dry goods',
  'tins & jars', 'frozen', 'spices & seasoning', 'drinks', 'other',
];

/** Order the card follows - roughly the order you walk a shop. */
const CATEGORY_ORDER = new Map(CATEGORIES.map((c, i) => [c, i]));

const LINES_PER_CARD = 11;      // line-units on a 3x5 card, notes included
const MAX_IMAGE_EDGE = 1568;    // Claude's optimal longest edge

const $ = (selector) => document.querySelector(selector);

$('#dateline').textContent = new Date().toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

const ARCHIVE_KEY = 'recipecard.archive';

const state = {
  card: null,
  images: [],
  removed: [],
  done: new Set(),
  showNotes: true,
  archiveId: null,   // which archive entry the open card belongs to
};

/* ------------------------------------------------------------- input UI */

const categorySelect = $('#add-category');
for (const category of CATEGORIES) {
  const option = document.createElement('option');
  option.value = category;
  option.textContent = category;
  categorySelect.append(option);
}
categorySelect.value = 'other';

/* One field, no choosing: lines that are all links are treated as links,
   anything else is recipe text, and images arrive by paste, drop or button. */

function looksLikeUrl(line) {
  if (/\s/.test(line)) return false;
  try {
    const url = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`);
    const labels = url.hostname.split('.');
    return labels.length >= 2 && /^[a-z]{2,}$/i.test(labels[labels.length - 1]);
  } catch {
    return false;
  }
}

function detectInput() {
  const raw = $('#recipe-input').value.trim();
  if (!raw) return { urls: [], text: '' };
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const urls = lines.filter(looksLikeUrl);
  if (urls.length && urls.length === lines.length) {
    return {
      urls: urls.slice(0, 5).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)),
      text: '',
    };
  }
  return { urls: [], text: raw };
}

function describeInput() {
  const { urls, text } = detectInput();
  const parts = [];
  if (urls.length) parts.push(`${urls.length} link${urls.length === 1 ? '' : 's'}`);
  if (text) parts.push(`recipe text (${text.split('\n').filter((l) => l.trim()).length} lines)`);
  if (state.images.length) parts.push(`${state.images.length} photo${state.images.length === 1 ? '' : 's'}`);
  const badge = $('#detected');
  badge.textContent = parts.length ? `detected: ${parts.join(' + ')}` : 'nothing yet — paste away';
  badge.classList.toggle('is-live', parts.length > 0);
}

$('#recipe-input').addEventListener('input', describeInput);

async function addPhotos(files) {
  for (const file of [...files].slice(0, 4 - state.images.length)) {
    if (!file.type.startsWith('image/')) continue;
    try {
      state.images.push(await downscale(file));
    } catch {
      setStatus(`Could not read ${file.name || 'that image'}.`, true);
    }
  }
  renderThumbs();
  describeInput();
}

$('#add-photo').addEventListener('click', () => $('#photos').click());
$('#photos').addEventListener('change', async (event) => {
  await addPhotos(event.target.files);
  event.target.value = '';
});

// Pasting a photo (from a screenshot tool, or a copied image) just works.
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    addPhotos(files);
  }
});

// So does dropping one onto the input area.
const dropzone = $('#dropzone');
for (const type of ['dragover', 'dragenter']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}
dropzone.addEventListener('drop', (event) => addPhotos(event.dataTransfer?.files || []));

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { name: file.name, mediaType: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl };
}

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.replaceChildren(
    ...state.images.map((image, index) => {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = image.preview;
      img.alt = image.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${image.name}`;
      remove.addEventListener('click', () => {
        state.images.splice(index, 1);
        renderThumbs();
        describeInput();
      });
      figure.append(img, remove);
      return figure;
    }),
  );
}

/* ------------------------------------------------------------- build */

$('#build').addEventListener('click', build);

async function build() {
  const button = $('#build');
  const { urls, text } = detectInput();

  if (!urls.length && !text && !state.images.length) {
    return setStatus('Paste a link, a photo, or some recipe text first.', true);
  }

  button.disabled = true;
  setStatus('Reading the recipe, converting the measurements…');

  try {
    const response = await fetch('/api/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls,
        text,
        images: state.images.map(({ mediaType, data }) => ({ mediaType, data })),
        servings: $('#servings').value.trim(),
        includeStaples: $('#staples').checked,
      }),
    });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        `The server sent back something that is not JSON (HTTP ${response.status}): ` +
        `"${raw.trim().slice(0, 120)}". If recipecard is behind a proxy or tunnel, it may be cutting the request short.`,
      );
    }
    if (!response.ok || body.error) throw new Error(body.error || `Server error ${response.status}`);

    state.card = body.card;
    normalizeNames(state.card);
    state.card.name = $('#card-name').value.trim() || state.card.title;
    let nextId = 0;
    for (const item of [...state.card.items, ...state.card.staples]) item.id = `item-${nextId++}`;
    state.removed = [];
    state.done = new Set();
    state.archiveId = archiveAdd(state.card);
    $('#output').hidden = false;
    render();
    setStatus(`${countItems()} things to buy.`);
    $('#output').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function setStatus(message, isError = false) {
  const status = $('#status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function countItems() {
  return (state.card?.items.length || 0) + (state.card?.staples.length || 0);
}

function updateMeta() {
  const meta = $('#output-meta');
  if (meta && state.card) {
    meta.textContent = `${countItems()} items · ${state.card.servings || 'as written'}`;
  }
}

/* ------------------------------------------------------------- render */

$('#show-notes').addEventListener('change', (event) => {
  state.showNotes = event.target.checked;
  render();
});

function render() {
  if (!state.card) return;
  renderWarnings();
  renderCards();
  renderTrash();
  updateMeta();
  archivePersistCurrent();
}

function renderWarnings() {
  const box = $('#warnings');
  const messages = [...(state.card.warnings || []), ...(state.card.notes || [])];
  box.hidden = messages.length === 0;
  box.replaceChildren(...messages.map((m) => {
    const p = document.createElement('p');
    p.textContent = m;
    return p;
  }));
}

/** How many ruled lines an item eats: one, plus one for its note. */
function lineCost(item) {
  const hasNote = state.showNotes && (item.varietyNote || item.note || item.alternatives?.length);
  return hasNote ? 2 : 1;
}

function paginate(items) {
  const pages = [];
  let page = [];
  let used = 0;
  for (const item of items) {
    const cost = lineCost(item);
    if (used + cost > LINES_PER_CARD && page.length) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(item);
    used += cost;
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const byCategory = (CATEGORY_ORDER.get(a.category) ?? 99) - (CATEGORY_ORDER.get(b.category) ?? 99);
    return byCategory || a.name.localeCompare(b.name);
  });
}

function renderCards() {
  const wrap = $('#cards');
  const shopping = paginate(sortItems(state.card.items));
  const staples = state.card.staples.length ? paginate(sortItems(state.card.staples)) : [];

  const cards = [
    ...shopping.map((items, i) =>
      buildCardElement({
        items,
        label: state.card.name || state.card.title,
        editableTitle: true,
        sub: [state.card.servings, state.card.sources?.length ? hostOf(state.card.sources[0]) : '']
          .filter(Boolean).join(' · '),
        page: i + 1,
        pages: shopping.length + staples.length,
        kraft: false,
      })),
    ...staples.map((items, i) =>
      buildCardElement({
        items,
        label: 'Cupboard check',
        sub: 'you may already have these',
        page: shopping.length + i + 1,
        pages: shopping.length + staples.length,
        kraft: true,
      })),
  ];

  wrap.replaceChildren(...cards);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function buildCardElement({ items, label, sub, page, pages, kraft, editableTitle }) {
  const card = el('article', 'card' + (kraft ? ' kraft' : ''));

  const head = el('div', 'card-head');
  const title = el('div', 'card-title');
  const titleText = el('span');
  titleText.textContent = label || 'Shopping';
  if (editableTitle) {
    titleText.contentEditable = 'true';
    titleText.spellcheck = false;
    titleText.title = 'Click to rename this card';
    titleText.addEventListener('input', () => {
      state.card.name = titleText.textContent.trim();
    });
    titleText.addEventListener('blur', () => render()); // sync other pages + archive
  }
  title.append(titleText);
  if (sub) {
    const small = el('span', 'card-sub');
    small.textContent = sub;
    title.append(small);
  }
  const marker = el('span', 'card-page');
  marker.textContent = pages > 1 ? `no. ${page} / ${pages}` : 'no. 1';
  head.append(title, marker);

  const list = el('ul', 'card-lines');
  for (const item of items) list.append(buildLine(item));

  // Keep short cards looking ruled rather than empty.
  for (let i = items.reduce((n, item) => n + lineCost(item), 0); i < LINES_PER_CARD; i++) {
    list.append(el('li', 'line'));
  }

  const foot = el('div', 'card-foot');
  foot.append(text('span', kraft ? 'cupboard · check' : 'shopping · list'));
  foot.append(text('span', `${items.length} item${items.length === 1 ? '' : 's'}`));

  card.append(head, list, foot);
  return card;
}

function buildLine(item) {
  const line = el('li', 'line');
  if (state.done.has(item.id)) line.classList.add('is-done');

  const tick = el('button', 'tick');
  tick.type = 'button';
  tick.title = 'Tick off';
  tick.addEventListener('click', () => {
    state.done.has(item.id) ? state.done.delete(item.id) : state.done.add(item.id);
    render();
  });

  const body = el('div', 'line-body');
  const top = el('div', 'line-top');

  const name = el('span', 'item-name');
  const nameText = el('span');
  nameText.textContent = item.name;
  nameText.contentEditable = 'true';
  nameText.spellcheck = false;
  nameText.title = 'Click to edit';
  nameText.addEventListener('input', () => {
    item.name = nameText.textContent.trim();
    archivePersistCurrent();
  });
  name.append(nameText);

  const buy = el('span', 'item-buy');
  buy.textContent = item.buy;
  buy.contentEditable = 'true';
  buy.spellcheck = false;
  buy.title = 'Click to edit';
  buy.addEventListener('input', () => {
    item.buy = buy.textContent.trim();
    archivePersistCurrent();
  });

  if (item.assumed) {
    const badge = el('span', 'badge');
    badge.textContent = 'assumed';
    badge.title = 'Inferred, not stated in the recipe';
    name.append(' ', badge);
  }

  top.append(name, buy);
  body.append(top);

  if (state.showNotes) {
    const note = buildNote(item);
    if (note) body.append(note);
  }

  const actions = el('span', 'line-actions');

  const edit = el('button');
  edit.type = 'button';
  edit.textContent = '✎';
  edit.title = 'Edit — or just click the name or amount';
  edit.addEventListener('click', () => {
    nameText.focus();
    const range = document.createRange();
    range.selectNodeContents(nameText);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const inCupboard = state.card.staples.includes(item);
  const move = el('button');
  move.type = 'button';
  move.textContent = inCupboard ? '↩' : '⌂';
  move.title = inCupboard ? 'Move back to the shopping list' : 'Move to the cupboard card';
  move.addEventListener('click', () => moveItem(item));

  const remove = el('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = `Remove ${item.name}`;
  remove.addEventListener('click', () => removeItem(item));

  actions.append(edit, move, remove);
  line.append(tick, body, actions);
  return line;
}

function buildNote(item) {
  const bits = [];
  if (item.varietyNote) {
    const why = item.varietySource === 'recipe' ? 'recipe:' : 'why:';
    bits.push(`<b>${escapeHtml(why)}</b> ${escapeHtml(item.varietyNote)}`);
  }
  if (item.note) bits.push(escapeHtml(item.note));
  if (item.alternatives?.length) {
    const alts = item.alternatives
      .map((alt) => `${escapeHtml(alt.name)}${alt.note ? ` (${escapeHtml(alt.note)})` : ''}`)
      .join(', ');
    bits.push(`<span class="alt">or ${alts}</span>`);
  }
  if (!bits.length) return null;
  const note = el('span', 'item-note');
  note.innerHTML = bits.join(' · ');
  return note;
}

/* ------------------------------------------------------------- editing */

function moveItem(item) {
  const fromStaples = state.card.staples.includes(item);
  const from = fromStaples ? state.card.staples : state.card.items;
  const to = fromStaples ? state.card.items : state.card.staples;
  const index = from.indexOf(item);
  if (index === -1) return;
  from.splice(index, 1);
  item.staple = !fromStaples;
  to.push(item);
  render();
  setStatus(fromStaples
    ? `${item.name} moved back to the shopping list.`
    : `${item.name} moved to the cupboard card - a reminder, not a purchase.`);
}

function removeItem(item) {
  for (const bucket of ['items', 'staples']) {
    const index = state.card[bucket].indexOf(item);
    if (index !== -1) {
      state.card[bucket].splice(index, 1);
      state.removed.push({ item, bucket });
      break;
    }
  }
  render();
  setStatus(`Removed ${item.name}. ${countItems()} left.`);
}

function renderTrash() {
  const box = $('#trash');
  const list = $('#trash-list');
  box.hidden = state.removed.length === 0;
  list.replaceChildren(...state.removed.map((entry, index) => {
    const li = document.createElement('li');
    li.append(document.createTextNode(entry.item.name));
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'put back';
    undo.addEventListener('click', () => {
      state.card[entry.bucket].push(entry.item);
      state.removed.splice(index, 1);
      render();
    });
    li.append(undo);
    return li;
  }));
}

$('#add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#add-name').value.trim();
  if (!name || !state.card) return;

  state.card.items.push({
    id: `manual-${Date.now()}`,
    name,
    buy: $('#add-buy').value.trim() || '—',
    category: $('#add-category').value,
    staple: false,
    sourceLines: [],
    count: null, countUnit: null, grams: null, milliliters: null,
    checked: false, approximate: false,
    variety: null, varietySource: 'none', varietyNote: null,
    alternatives: [],
    assumed: false,
    note: 'added by hand',
    manual: true,
  });

  $('#add-name').value = '';
  $('#add-buy').value = '';
  render();
  setStatus(`Added ${name}. ${countItems()} things to buy.`);
});

/* ------------------------------------------------------------- output */

$('#print').addEventListener('click', () => window.print());

$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(asPlainText());
  setStatus('Copied the list to the clipboard.');
});

$('#download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.card, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${slug(state.card.name || state.card.title)}-shopping-list.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

function asPlainText() {
  const lines = [(state.card.name || state.card.title).toUpperCase()];
  if (state.card.servings) lines.push(state.card.servings);
  lines.push('');

  const section = (heading, items) => {
    if (!items.length) return;
    lines.push(heading);
    for (const item of sortItems(items)) {
      lines.push(`[ ] ${item.name} — ${item.buy}`);
      const extras = [
        item.varietyNote && `${item.varietySource === 'recipe' ? 'recipe' : 'why'}: ${item.varietyNote}`,
        item.note,
        item.alternatives?.length &&
          `or ${item.alternatives.map((a) => (a.note ? `${a.name} (${a.note})` : a.name)).join(', ')}`,
      ].filter(Boolean);
      for (const extra of extras) lines.push(`      ${extra}`);
    }
    lines.push('');
  };

  section('TO BUY', state.card.items);
  section('CUPBOARD CHECK', state.card.staples);
  if (state.card.sources?.length) lines.push(`Source: ${state.card.sources.join(', ')}`);
  return lines.join('\n');
}

/** "Russet" + "Potatoes" become one editable name: "Russet Potatoes".
    Runs once per item - a later rename must never get the prefix back. */
function normalizeNames(card) {
  for (const item of [...(card.items || []), ...(card.staples || [])]) {
    if (item.varietyFolded) continue;
    if (item.variety && !item.name.toLowerCase().includes(item.variety.toLowerCase())) {
      item.name = `${item.variety} ${item.name}`;
    }
    item.varietyFolded = true;
  }
}

/* ------------------------------------------------------------- archive */

function archiveLoad() {
  try {
    const list = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function archiveSave(list) {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list));
  } catch {
    setStatus('Could not save to the archive - browser storage is full or blocked.', true);
  }
  renderArchive();
}

function archiveAdd(card) {
  const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const list = archiveLoad();
  list.unshift({
    id,
    name: card.name || card.title,
    createdAt: new Date().toISOString(),
    done: [],
    card,
  });
  archiveSave(list);
  return id;
}

/** Keep the open card's archive entry in step with every edit. */
function archivePersistCurrent() {
  if (!state.card || !state.archiveId) return;
  const list = archiveLoad();
  const entry = list.find((e) => e.id === state.archiveId);
  if (!entry) return;
  entry.name = state.card.name || state.card.title;
  entry.card = state.card;
  entry.done = [...state.done];
  archiveSave(list);
}

function archiveOpen(id) {
  const entry = archiveLoad().find((e) => e.id === id);
  if (!entry) return;
  state.card = JSON.parse(JSON.stringify(entry.card));
  normalizeNames(state.card);
  let nextId = 0;
  for (const item of [...state.card.items, ...state.card.staples]) item.id = `item-${nextId++}`;
  state.done = new Set(entry.done || []);
  state.removed = [];
  state.archiveId = id;
  $('#output').hidden = false;
  render();
  setStatus(`Opened "${entry.name}".`);
}

function archiveDelete(id) {
  const list = archiveLoad().filter((e) => e.id !== id);
  if (state.archiveId === id) state.archiveId = null; // the open copy stays, unsaved
  archiveSave(list);
}

function renderArchive() {
  const section = $('#archive');
  const list = archiveLoad();
  section.hidden = list.length === 0;
  $('#archive-meta').textContent = `${list.length} card${list.length === 1 ? '' : 's'} · saved in this browser`;

  $('#archive-list').replaceChildren(...list.map((entry) => {
    const tile = el('article', 'archive-tile' + (entry.id === state.archiveId ? ' is-open' : ''));

    const head = el('div', 'archive-tile-head');
    const name = text('h3', entry.name || 'Untitled card');
    const when = text('span', new Date(entry.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    }).toLowerCase());
    head.append(name, when);

    const total = (entry.card.items?.length || 0) + (entry.card.staples?.length || 0);
    const host = entry.card.sources?.length ? hostOf(entry.card.sources[0]) : '';
    const meta = text('p', [
      `${total} item${total === 1 ? '' : 's'}`,
      entry.card.servings,
      host,
    ].filter(Boolean).join(' · '));
    meta.className = 'archive-tile-meta';

    const row = el('div', 'archive-tile-actions');
    const open = text('button', 'Open');
    open.type = 'button';
    open.addEventListener('click', () => {
      archiveOpen(entry.id);
      $('#output').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const print = text('button', 'Print');
    print.type = 'button';
    print.addEventListener('click', () => {
      archiveOpen(entry.id);
      setTimeout(() => window.print(), 60); // let the card paint first
    });
    const del = text('button', 'Delete');
    del.type = 'button';
    del.className = 'danger';
    del.addEventListener('click', () => archiveDelete(entry.id));
    row.append(open, print, del);

    tile.append(head, meta, row);
    return tile;
  }));
}

renderArchive();

/* ------------------------------------------------------------- helpers */

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag, content) {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slug(value) {
  return String(value || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recipe';
}
