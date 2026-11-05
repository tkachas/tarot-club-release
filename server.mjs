import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const baseDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(baseDir, 'public');
const dataDir = resolve(process.env.DATA_DIR || join(baseDir, 'data'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'tarot.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
  INSERT OR IGNORE INTO meta (id, revision) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS card_readings (
    id TEXT PRIMARY KEY,
    card_index INTEGER NOT NULL CHECK (card_index BETWEEN 0 AND 77),
    text TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journals (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    question TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    result_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS extras (
    id TEXT PRIMARY KEY,
    journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
    question TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spread_cards (
    owner_type TEXT NOT NULL CHECK (owner_type IN ('journal', 'extra')),
    owner_id TEXT NOT NULL,
    card_index INTEGER NOT NULL CHECK (card_index BETWEEN 0 AND 77),
    PRIMARY KEY (owner_type, owner_id, card_index)
  );
`);

const csrfToken = randomBytes(32).toString('hex');
const bump = db.prepare('UPDATE meta SET revision = revision + 1 WHERE id = 1');
const revision = () => db.prepare('SELECT revision FROM meta WHERE id = 1').get().revision;
const now = () => new Date().toISOString();
const cardIndex = value => Number.isInteger(value) && value >= 0 && value < 78;

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function state() {
  const readings = db.prepare('SELECT * FROM card_readings ORDER BY created_at, id').all();
  const journals = db.prepare('SELECT * FROM journals ORDER BY date DESC, created_at DESC').all();
  const extras = db.prepare('SELECT * FROM extras ORDER BY created_at, id').all();
  const cards = db.prepare('SELECT * FROM spread_cards ORDER BY card_index').all();
  const extraMap = new Map(extras.map(extra => [extra.id, { ...extra, cards: [] }]));
  for (const journal of journals) { journal.cards = []; journal.extras = []; }
  const journalMap = new Map(journals.map(journal => [journal.id, journal]));
  for (const card of cards) {
    const owner = card.owner_type === 'journal' ? journalMap.get(card.owner_id) : extraMap.get(card.owner_id);
    owner?.cards.push(card.card_index);
  }
  for (const extra of extraMap.values()) journalMap.get(extra.journal_id)?.extras.push(extra);
  return { revision: revision(), csrfToken, readings, journals };
}

const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function error(status, message, extra = {}) {
  return { status, message, extra };
}

async function bodyOf(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error(415, 'Ожидается JSON');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw error(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw error(400, 'Некорректный JSON');
  }
}

function ensureMutation(req) {
  const given = String(req.headers['x-csrf-token'] || '');
  const expected = Buffer.from(csrfToken);
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw error(403, 'Обновите страницу и повторите');
  const origin = req.headers.origin;
  if (origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin)) throw error(403, 'Недопустимый источник запроса');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw error(403, 'Недопустимый источник запроса');
}

const fields = {
  reading: { text: ['text', 10000], author: ['author', 100] },
  journal: { date: ['date', 10], question: ['question', 500], text: ['text', 10000], result: ['result', 6], resultText: ['result_text', 10000] },
  extra: { question: ['question', 500], text: ['text', 10000] }
};
const tables = { reading: 'card_readings', journal: 'journals', extra: 'extras' };
function validateField(kind, field, value) {
  const spec = fields[kind]?.[field];
  if (!spec || typeof value !== 'string' || value.length > spec[1]) throw error(400, 'Недопустимое значение поля');
  if (field === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error(400, 'Недопустимая дата');
  if (field === 'result' && !['', 'green', 'yellow', 'red'].includes(value)) throw error(400, 'Недопустимый итог');
  return spec[0];
}
function patchField(kind, id, payload) {
  const { field, value, expected } = payload;
  const column = validateField(kind, field, value);
  if (typeof expected !== 'string') throw error(400, 'Не указано исходное значение');
  const table = tables[kind];
  const row = db.prepare(`SELECT ${column} FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw error(404, 'Запись не найдена');
  if (row[column] !== expected) throw error(409, 'Поле изменено другим участником', { current: row[column] });
  if (value !== expected) {
    db.prepare(`UPDATE ${table} SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, now(), id);
    bump.run();
  }
  return { value, revision: revision() };
}

function ownerExists(type, id) {
  return db.prepare(`SELECT 1 FROM ${type === 'journal' ? 'journals' : 'extras'} WHERE id = ?`).get(id);
}

async function api(req, res, path, searchParams) {
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && path === '/api/state') {
    if (searchParams.get('since') === String(revision())) {
      res.writeHead(204, { ...headers, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return json(res, 200, state());
  }
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw error(404, 'Не найдено');
  ensureMutation(req);
  const payload = req.method === 'DELETE' ? {} : await bodyOf(req);
  let match;

  if (req.method === 'POST' && path === '/api/readings') {
    if (!cardIndex(payload.cardIndex)) throw error(400, 'Неизвестная карта');
    const id = randomUUID(), time = now();
    db.prepare('INSERT INTO card_readings (id, card_index, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, payload.cardIndex, time, time);
    bump.run();
    return json(res, 201, { id, revision: revision() });
  }
  if ((match = /^\/api\/readings\/([0-9a-f-]{36})$/.exec(path))) {
    if (req.method === 'PATCH') return json(res, 200, patchField('reading', match[1], payload));
    if (req.method === 'DELETE') {
      const result = db.prepare('DELETE FROM card_readings WHERE id = ?').run(match[1]);
      if (!result.changes) throw error(404, 'Запись не найдена');
      bump.run();
      return json(res, 200, { revision: revision() });
    }
  }
  if (req.method === 'POST' && path === '/api/journals') {
    const date = payload.date || new Date().toISOString().slice(0, 10);
    validateField('journal', 'date', date);
    const id = randomUUID(), time = now();
    db.prepare('INSERT INTO journals (id, date, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, date, time, time);
    bump.run();
    return json(res, 201, { id, revision: revision() });
  }
  if ((match = /^\/api\/journals\/([0-9a-f-]{36})$/.exec(path))) {
    if (req.method === 'PATCH') return json(res, 200, patchField('journal', match[1], payload));
    if (req.method === 'DELETE') {
      transaction(() => {
        if (!ownerExists('journal', match[1])) throw error(404, 'Запись не найдена');
        const extras = db.prepare('SELECT id FROM extras WHERE journal_id = ?').all(match[1]);
        db.prepare("DELETE FROM spread_cards WHERE owner_type = 'journal' AND owner_id = ?").run(match[1]);
        for (const extra of extras) db.prepare("DELETE FROM spread_cards WHERE owner_type = 'extra' AND owner_id = ?").run(extra.id);
        db.prepare('DELETE FROM journals WHERE id = ?').run(match[1]);
        bump.run();
      });
      return json(res, 200, { revision: revision() });
    }
  }
  if ((match = /^\/api\/journals\/([0-9a-f-]{36})\/extras$/.exec(path)) && req.method === 'POST') {
    if (!ownerExists('journal', match[1])) throw error(404, 'Запись не найдена');
    const id = randomUUID(), time = now();
    db.prepare('INSERT INTO extras (id, journal_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, match[1], time, time);
    bump.run();
    return json(res, 201, { id, revision: revision() });
  }
  if ((match = /^\/api\/extras\/([0-9a-f-]{36})$/.exec(path))) {
    if (req.method === 'PATCH') return json(res, 200, patchField('extra', match[1], payload));
    if (req.method === 'DELETE') {
      transaction(() => {
        if (!ownerExists('extra', match[1])) throw error(404, 'Запись не найдена');
        db.prepare("DELETE FROM spread_cards WHERE owner_type = 'extra' AND owner_id = ?").run(match[1]);
        db.prepare('DELETE FROM extras WHERE id = ?').run(match[1]);
        bump.run();
      });
      return json(res, 200, { revision: revision() });
    }
  }
  if ((match = /^\/api\/(journals|extras)\/([0-9a-f-]{36})\/cards(?:\/(\d+))?$/.exec(path))) {
    const type = match[1] === 'journals' ? 'journal' : 'extra', id = match[2];
    if (!ownerExists(type, id)) throw error(404, 'Запись не найдена');
    if (req.method === 'POST' && match[3] === undefined) {
      if (!cardIndex(payload.cardIndex)) throw error(400, 'Неизвестная карта');
      const result = db.prepare('INSERT OR IGNORE INTO spread_cards VALUES (?, ?, ?)').run(type, id, payload.cardIndex);
      if (result.changes) bump.run();
      return json(res, 200, { revision: revision() });
    }
    if (req.method === 'DELETE' && match[3] !== undefined) {
      const index = Number(match[3]);
      if (!cardIndex(index)) throw error(400, 'Неизвестная карта');
      const result = db.prepare('DELETE FROM spread_cards WHERE owner_type = ? AND owner_id = ? AND card_index = ?').run(type, id, index);
      if (result.changes) bump.run();
      return json(res, 200, { revision: revision() });
    }
  }
  throw error(404, 'Не найдено');
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/original.css', ['original.css', 'text/css; charset=utf-8']],
  ['/cards.json', ['cards.json', 'application/json; charset=utf-8']]
]);
function serveStatic(req, res, path) {
  const card = /^\/cards\/(\d{2})\.jpg$/.exec(path);
  const entry = card ? [`cards/${card[1]}.jpg`, 'image/jpeg'] : staticFiles.get(path);
  if (!entry) throw error(404, 'Не найдено');
  const file = join(publicDir, entry[0]);
  if (!existsSync(file)) throw error(404, 'Не найдено');
  const stat = statSync(file);
  res.writeHead(200, { ...headers, 'Content-Type': entry[1], 'Content-Length': stat.size, 'Cache-Control': card ? 'private, max-age=86400' : 'no-store' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url.pathname, url.searchParams);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else throw error(405, 'Метод не поддерживается');
  } catch (problem) {
    if (res.headersSent) return res.destroy();
    const status = problem.status || 500;
    if (status === 500) console.error(problem);
    json(res, status, { error: problem.message || 'Ошибка сервера', ...(problem.extra || {}) });
  }
});
server.listen(port, host, () => console.log(`Tarot Club listening on http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
