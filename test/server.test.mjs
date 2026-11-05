import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectDir = resolve(import.meta.dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function start(port, dataDir) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectDir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { child, base };
    } catch {}
    await delay(100);
  }
  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
}

test('shared state persists and rejects stale or unauthorised edits', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tarot-club-test-'));
  const port = await freePort();
  let server;
  try {
    server = await start(port, dataDir);
    const api = async (method, path, body, token) => {
      const response = await fetch(`${server.base}${path}`, {
        method,
        headers: { ...(token ? { 'X-CSRF-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };

    let response = await api('GET', '/api/state');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.readings, []);
    const token = response.body.csrfToken;
    assert.ok(token);

    response = await api('POST', '/api/readings', { cardIndex: 0 });
    assert.equal(response.status, 403);
    response = await api('POST', '/api/readings', { cardIndex: 78 }, token);
    assert.equal(response.status, 400);
    response = await api('POST', '/api/readings', { cardIndex: 0 }, token);
    assert.equal(response.status, 201);
    const readingId = response.body.id;
    response = await api('PATCH', `/api/readings/${readingId}`, { field: 'text', value: 'Первый смысл', expected: '' }, token);
    assert.equal(response.status, 200);
    response = await api('PATCH', `/api/readings/${readingId}`, { field: 'text', value: 'Чужая правка', expected: '' }, token);
    assert.equal(response.status, 409);
    assert.equal(response.body.current, 'Первый смысл');
    response = await api('PATCH', `/api/readings/${readingId}`, { field: 'author', value: 'Оля', expected: '' }, token);
    assert.equal(response.status, 200);

    response = await api('POST', '/api/journals', { date: '2026-11-05' }, token);
    assert.equal(response.status, 201);
    const journalId = response.body.id;
    response = await api('POST', `/api/journals/${journalId}/cards`, { cardIndex: 0 }, token);
    assert.equal(response.status, 200);
    response = await api('POST', `/api/journals/${journalId}/extras`, {}, token);
    assert.equal(response.status, 201);
    const extraId = response.body.id;
    response = await api('PATCH', `/api/extras/${extraId}`, { field: 'question', value: 'Уточнение?', expected: '' }, token);
    assert.equal(response.status, 200);
    response = await api('POST', `/api/extras/${extraId}/cards`, { cardIndex: 3 }, token);
    assert.equal(response.status, 200);

    response = await api('GET', '/api/state');
    assert.equal(response.body.readings[0].text, 'Первый смысл');
    assert.equal(response.body.readings[0].author, 'Оля');
    assert.deepEqual(response.body.journals[0].cards, [0]);
    assert.deepEqual(response.body.journals[0].extras[0].cards, [3]);
    assert.equal(response.body.journals[0].extras[0].question, 'Уточнение?');
    const revision = response.body.revision;
    const unchanged = await fetch(`${server.base}/api/state?since=${revision}`);
    assert.equal(unchanged.status, 204);

    const source = await fetch(`${server.base}/server.mjs`);
    assert.equal(source.status, 404);
    const cards = await fetch(`${server.base}/cards.json`);
    assert.equal((await cards.json()).length, 78);
    const image = await fetch(`${server.base}/cards/01.jpg`);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');

    await stop(server.child);
    server = await start(port, dataDir);
    response = await api('GET', '/api/state');
    assert.equal(response.body.readings[0].text, 'Первый смысл');
    assert.equal(response.body.journals[0].extras[0].question, 'Уточнение?');
  } finally {
    if (server) await stop(server.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

