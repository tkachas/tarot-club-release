const byId = id => document.getElementById(id);
const make = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const button = (text, action, className = '') => {
  const node = make('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};

let cards = [];
let snapshot = { revision: -1, csrfToken: '', readings: [], journals: [] };
let currentView = 'book';
let currentGroup = 'Все карты';
let openCard = null;
let pickerTarget = null;
let savesInFlight = 0;
let statusTimer;

function notice(message, sticky = false) {
  clearTimeout(statusTimer);
  byId('save-status').textContent = message;
  if (!sticky) statusTimer = setTimeout(() => { byId('save-status').textContent = ''; }, 4500);
}

function normalize(value) { return value.toLowerCase().replaceAll('ё', 'е').trim(); }
function remoteFieldActive() { return document.activeElement?.classList.contains('remote-field'); }

async function request(method, path, data) {
  savesInFlight++;
  try {
    const response = await fetch(path, {
      method,
      headers: {
        'X-CSRF-Token': snapshot.csrfToken,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось сохранить'), { status: response.status, current: result.current });
    snapshot.revision = result.revision;
    return result;
  } finally {
    savesInFlight--;
  }
}

async function refresh(force = false) {
  if (remoteFieldActive() || savesInFlight) return;
  const suffix = !force && snapshot.revision >= 0 ? `?since=${snapshot.revision}` : '';
  const response = await fetch(`/api/state${suffix}`, { cache: 'no-store' });
  if (response.status === 204) return;
  if (!response.ok) throw new Error('Не удалось загрузить общие записи');
  const next = await response.json();
  if (remoteFieldActive() || savesInFlight) return;
  snapshot = next;
  if (currentView === 'book') renderBook();
  else renderJournal();
}

async function action(method, path, payload, after) {
  try {
    const result = await request(method, path, payload);
    await refresh(true);
    after?.(result);
    notice('Сохранено ✧');
  } catch (problem) {
    notice(problem.message || 'Не удалось сохранить. Повторите попытку.', true);
  }
}

function makeField(parent, { kind, id, field, label, value = '', type = 'textarea', options }) {
  const wrap = make('div', 'field');
  const caption = make('label', '', label);
  const input = make(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', 'remote-field');
  const inputId = `field-${id}-${field}`;
  input.id = inputId;
  caption.htmlFor = inputId;
  if (type === 'date') input.type = 'date';
  if (field === 'author') input.setAttribute('list', 'author-suggestions');
  if (options) for (const [choice, text] of options) {
    const option = make('option', '', text);
    option.value = choice;
    input.append(option);
  }
  input.value = value;
  const warning = make('div', 'field-warning');
  wrap.append(caption, input, warning);
  parent.append(wrap);

  let saved = value, timer, busy = false, conflicted = false;
  const path = kind === 'reading' ? `/api/readings/${id}` : kind === 'journal' ? `/api/journals/${id}` : `/api/extras/${id}`;

  function conflict(remoteValue) {
    conflicted = true;
    warning.replaceChildren(make('span', '', 'Это поле изменили с другого устройства. Ваш текст пока остался здесь. '));
    warning.append(
      button('Оставить мою версию', () => {
        saved = remoteValue;
        conflicted = false;
        warning.replaceChildren();
        flush();
      }),
      button('Загрузить новую', () => {
        input.value = remoteValue;
        saved = remoteValue;
        conflicted = false;
        warning.replaceChildren();
        refresh(true).catch(problem => notice(problem.message, true));
      })
    );
  }
  function retry(message) {
    warning.replaceChildren(make('span', '', `${message}. Изменение осталось в этом поле. `));
    warning.append(button('Повторить', () => { warning.replaceChildren(); flush(); }));
  }
  async function flush() {
    clearTimeout(timer);
    if (busy || conflicted || input.value === saved) return;
    busy = true;
    const sent = input.value;
    try {
      await request('PATCH', path, { field, value: sent, expected: saved });
      saved = sent;
      warning.replaceChildren();
      notice('Сохранено ✧');
    } catch (problem) {
      if (problem.status === 409) conflict(problem.current);
      else retry(problem.message || 'Не удалось сохранить');
    } finally {
      busy = false;
    }
    if (!conflicted && input.value !== saved) timer = setTimeout(flush, 300);
    else if (!conflicted && document.activeElement !== input) refresh(true).catch(problem => notice(problem.message, true));
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 650); });
  input.addEventListener('blur', () => { if (type !== 'textarea') flush(); else timer = setTimeout(flush, 0); });
  if (type === 'select' || type === 'date') input.addEventListener('change', () => { flush(); input.blur(); });
  return input;
}

function setView(view) {
  currentView = view;
  byId('book-view').hidden = view !== 'book';
  byId('journal-view').hidden = view !== 'journal';
  byId('book-nav').classList.toggle('active', view === 'book');
  byId('journal-nav').classList.toggle('active', view === 'journal');
  if (view === 'book') renderBook(); else renderJournal();
  window.scrollTo(0, 0);
}

const groups = ['Все карты', 'Старшие арканы', 'Жезлы', 'Кубки', 'Мечи', 'Пентакли'];
function renderFilters() {
  const nav = byId('filters');
  for (const group of groups) nav.append(button(group, () => {
    currentGroup = group;
    for (const item of nav.querySelectorAll('button')) item.classList.toggle('active', item.textContent === group);
    renderBook();
  }, group === currentGroup ? 'active' : ''));
}

function readingsFor(cardIndex) { return snapshot.readings.filter(reading => reading.card_index === cardIndex); }

function renderBook() {
  const grid = byId('grid');
  grid.replaceChildren();
  const search = normalize(byId('search').value);
  let filled = 0;
  for (const card of cards) {
    const readings = readingsFor(card.id);
    if (readings.some(reading => reading.text.trim())) filled++;
    if ((currentGroup !== 'Все карты' && card.group !== currentGroup) || !normalize(card.title).includes(search)) continue;
    const article = make('article', 'card');
    const scene = make('div', 'scene');
    if (openCard === card.id) scene.classList.add('flipped');
    const inner = make('div', 'inner');
    const front = button('', () => { openCard = card.id; scene.classList.add('flipped'); }, 'face front');
    front.setAttribute('aria-label', `${card.title} — открыть трактовки`);
    const image = make('img'); image.src = card.image; image.alt = card.title; image.loading = 'lazy'; image.decoding = 'async';
    front.append(image);
    const back = make('div', 'face back');
    back.append(make('div', 'back-heading', card.title));
    const list = make('div', 'readings');
    if (!readings.length) list.append(make('p', 'reading-empty', 'Трактовок пока нет. Добавьте первую ✧'));
    for (const reading of readings) {
      const section = make('section', 'reading');
      section.dataset.readingId = reading.id;
      makeField(section, { kind: 'reading', id: reading.id, field: 'text', label: 'Трактовка', value: reading.text });
      const actions = make('div', 'reading-actions');
      makeField(actions, { kind: 'reading', id: reading.id, field: 'author', label: 'Автор', value: reading.author, type: 'text' });
      actions.append(button('Удалить трактовку', () => {
        if (confirm('Удалить эту трактовку?')) action('DELETE', `/api/readings/${reading.id}`);
      }, 'remove-reading'));
      section.append(actions);
      list.append(section);
    }
    const add = button('＋ Добавить трактовку', async () => {
      try {
        const created = await request('POST', '/api/readings', { cardIndex: card.id });
        const author = byId('my-name').value.trim();
        if (author) await request('PATCH', `/api/readings/${created.id}`, { field: 'author', value: author, expected: '' });
        openCard = card.id;
        await refresh(true);
        document.querySelector(`[data-reading-id="${created.id}"] textarea`)?.focus();
        notice('Трактовка добавлена ✧');
      } catch (problem) { notice(problem.message, true); }
    }, 'add-reading');
    const close = button('↶ Вернуться к карте', () => { openCard = null; scene.classList.remove('flipped'); front.focus(); });
    back.append(list, add, close);
    inner.append(front, back); scene.append(inner);
    article.append(scene, make('h2', '', card.title));
    const meta = make('div', 'meta');
    meta.append(make('small', '', card.group), make('small', '', `${readings.length} ${readings.length === 1 ? 'трактовка' : 'трактовок'}`));
    article.append(meta); grid.append(article);
  }
  byId('book-status').textContent = `✧ Заполнено ${filled} из ${cards.length}`;
  byId('empty').hidden = grid.children.length > 0;
}

function spread(parent, owner, kind) {
  const row = make('div', 'spread');
  for (const index of owner.cards) {
    const card = cards[index];
    if (!card) continue;
    const item = make('div', 'spread-card');
    const image = make('img'); image.src = card.image; image.alt = card.title; image.loading = 'lazy';
    item.append(image, make('span', '', card.title));
    item.append(button('×', () => action('DELETE', `/api/${kind}/${owner.id}/cards/${index}`)));
    row.append(item);
  }
  parent.append(row, button('＋ Выбрать карты', () => openPicker(kind, owner)));
  for (const index of owner.cards) {
    const card = cards[index];
    if (!card) continue;
    const filled = readingsFor(index).filter(reading => reading.text.trim());
    if (!filled.length) { parent.append(make('p', 'empty-pull', `${card.title} — в колоде пока нет трактовок`)); continue; }
    const box = make('div', 'pulled');
    box.append(make('strong', '', card.title));
    for (const reading of filled) box.append(make('p', '', reading.text), make('small', '', reading.author || 'Без автора'));
    parent.append(box);
  }
}

function renderJournal() {
  const list = byId('journal-list');
  list.replaceChildren();
  if (!snapshot.journals.length) list.append(make('p', 'empty-journal', 'Здесь появятся ваши гадания ✧'));
  for (const entry of snapshot.journals) {
    const article = make('article', 'journal-entry');
    const top = make('div', 'entry-top');
    top.append(make('span', 'entry-note', '✧ Общая запись'));
    makeField(top, { kind: 'journal', id: entry.id, field: 'date', label: 'Дата', value: entry.date, type: 'date' });
    article.append(top);
    makeField(article, { kind: 'journal', id: entry.id, field: 'question', label: 'Какой вопрос был?', value: entry.question, type: 'text' });
    spread(article, entry, 'journals');
    makeField(article, { kind: 'journal', id: entry.id, field: 'text', label: 'Наша трактовка расклада', value: entry.text });
    for (const [index, extra] of entry.extras.entries()) {
      const section = make('section', 'question-block');
      makeField(section, { kind: 'extra', id: extra.id, field: 'question', label: `Дополнительный вопрос ${index + 1}`, value: extra.question, type: 'text' });
      spread(section, extra, 'extras');
      makeField(section, { kind: 'extra', id: extra.id, field: 'text', label: 'Трактовка поясняющих карт', value: extra.text });
      section.append(button('Удалить доп. вопрос', () => {
        if (confirm('Удалить дополнительный вопрос?')) action('DELETE', `/api/extras/${extra.id}`);
      }, 'danger'));
      article.append(section);
    }
    const actions = make('div', 'entry-actions');
    actions.append(button('＋ Дополнительный вопрос', () => action('POST', `/api/journals/${entry.id}/extras`, {})));
    actions.append(button('Удалить гадание', () => {
      if (confirm('Удалить гадание и все его дополнительные вопросы?')) action('DELETE', `/api/journals/${entry.id}`);
    }, 'danger'));
    article.append(actions);
    const outcome = make('section', `outcome ${entry.result}`);
    makeField(outcome, { kind: 'journal', id: entry.id, field: 'result', label: 'Как проигралось?', value: entry.result, type: 'select', options: [
      ['', '○ Пока не известно'], ['green', '🟢 Зелёный — совпало'],
      ['yellow', '🟡 Жёлтый — частично'], ['red', '🔴 Красный — не совпало']
    ] });
    makeField(outcome, { kind: 'journal', id: entry.id, field: 'resultText', label: 'Что произошло на самом деле?', value: entry.result_text });
    article.append(outcome);
    list.append(article);
  }
}

function openPicker(kind, owner) {
  pickerTarget = { kind, id: owner.id, selected: new Set(owner.cards) };
  byId('picker-search').value = '';
  drawPicker();
  byId('picker').showModal();
}

function drawPicker() {
  const grid = byId('picker-grid');
  grid.replaceChildren();
  const search = normalize(byId('picker-search').value);
  for (const card of cards) {
    if (!normalize(card.title).includes(search)) continue;
    const selected = pickerTarget.selected.has(card.id);
    const tile = button('', async () => {
      const selectedNow = pickerTarget.selected.has(card.id);
      const path = `/api/${pickerTarget.kind}/${pickerTarget.id}/cards`;
      try {
        if (selectedNow) await request('DELETE', `${path}/${card.id}`);
        else await request('POST', path, { cardIndex: card.id });
        if (selectedNow) pickerTarget.selected.delete(card.id); else pickerTarget.selected.add(card.id);
        drawPicker();
        await refresh(true);
      } catch (problem) { notice(problem.message, true); }
    }, selected ? 'selected' : '');
    tile.setAttribute('aria-pressed', String(selected));
    const image = make('img'); image.src = card.image; image.alt = card.title; image.loading = 'lazy';
    tile.append(image, make('span', '', `${selected ? '✓ ' : ''}${card.title}`));
    grid.append(tile);
  }
}

async function start() {
  try {
    const [cardResponse, stateResponse] = await Promise.all([
      fetch('/cards.json'), fetch('/api/state', { cache: 'no-store' })
    ]);
    if (!cardResponse.ok || !stateResponse.ok) throw new Error('Не удалось загрузить приложение');
    cards = await cardResponse.json();
    snapshot = await stateResponse.json();
    renderFilters(); renderBook();
    byId('my-name').value = localStorage.getItem('tarot-author-name') || '';
    byId('my-name').addEventListener('input', event => localStorage.setItem('tarot-author-name', event.target.value));
    byId('search').addEventListener('input', renderBook);
    byId('book-nav').addEventListener('click', () => setView('book'));
    byId('journal-nav').addEventListener('click', () => setView('journal'));
    byId('new-reading').addEventListener('click', () => action('POST', '/api/journals', { date: new Date().toLocaleDateString('sv-SE') }));
    byId('picker-close').addEventListener('click', () => byId('picker').close());
    byId('picker-search').addEventListener('input', drawPicker);
    setInterval(() => refresh().catch(problem => notice(problem.message, true)), 5000);
    window.addEventListener('focus', () => refresh().catch(problem => notice(problem.message, true)));
  } catch (problem) { notice(problem.message, true); byId('book-status').textContent = problem.message; }
}
start();
