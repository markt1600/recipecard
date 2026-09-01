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

const state = {
  card: null,
  images: [],
  removed: [],
  done: new Set(),
  showNotes: true,
};

/* ------------------------------------------------------------- input UI */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
    }
  });
}

const categorySelect = $('#add-category');
for (const category of CATEGORIES) {
  const option = document.createElement('option');
  option.value = category;
  option.textContent = category;
  categorySelect.append(option);
}
categorySelect.value = 'other';

/* Photos are downscaled in the browser: smaller upload, and 1568px is as much
   as the model uses anyway. */
$('#photos').addEventListener('change', async (event) => {
  for (const file of [...event.target.files].slice(0, 4 - state.images.length)) {
    try {
      state.images.push(await downscale(file));
    } catch {
      setStatus(`Could not read ${file.name}.`, true);
    }
  }
  event.target.value = '';
  renderThumbs();
});

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
  const urls = $('#urls').value.split('\n').map((u) => u.trim()).filter(Boolean);
  const text = $('#pasted').value.trim();

  if (!urls.length && !text && !state.images.length) {
    return setStatus('Add a link, a photo, or some recipe text first.', true);
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
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Server error ${response.status}`);

    state.card = body.card;
    let nextId = 0;
    for (const item of [...state.card.items, ...state.card.staples]) item.id = `item-${nextId++}`;
    state.removed = [];
    state.done = new Set();
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
        label: state.card.title,
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

function buildCardElement({ items, label, sub, page, pages, kraft }) {
  const card = el('article', 'card' + (kraft ? ' kraft' : ''));

  const head = el('div', 'card-head');
  const title = el('div', 'card-title');
  title.textContent = label || 'Shopping';
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
  const varietyShown = item.variety && !item.name.toLowerCase().includes(item.variety.toLowerCase());
  if (varietyShown) {
    const variety = el('span', 'item-variety');
    variety.textContent = `${item.variety} `;
    name.append(variety);
  }
  const nameText = el('span');
  nameText.textContent = item.name;
  nameText.contentEditable = 'true';
  nameText.spellcheck = false;
  nameText.title = 'Click to edit';
  nameText.addEventListener('input', () => { item.name = nameText.textContent.trim(); });
  name.append(nameText);

  const buy = el('span', 'item-buy');
  buy.textContent = item.buy;
  buy.contentEditable = 'true';
  buy.spellcheck = false;
  buy.title = 'Click to edit';
  buy.addEventListener('input', () => { item.buy = buy.textContent.trim(); });

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

  const remove = el('button', 'remove');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = `Remove ${item.name}`;
  remove.addEventListener('click', () => removeItem(item));

  line.append(tick, body, remove);
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
  link.download = `${slug(state.card.title)}-shopping-list.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

function asPlainText() {
  const lines = [state.card.title.toUpperCase()];
  if (state.card.servings) lines.push(state.card.servings);
  lines.push('');

  const section = (heading, items) => {
    if (!items.length) return;
    lines.push(heading);
    for (const item of sortItems(items)) {
      const label = [item.variety, item.name].filter(Boolean).join(' ');
      lines.push(`[ ] ${label} — ${item.buy}`);
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
