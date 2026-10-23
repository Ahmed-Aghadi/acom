// Disposable HTTP transport regressions; no provider clients or live data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const MAX_BODY = 16 * 1024 * 1024;

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-http-boundary-'));
  for (const name of ['data', 'user', 'empty-bin', 'project']) fs.mkdirSync(path.join(root, name));
  const home = path.join(root, 'data'), project = path.join(root, 'project');
  const env = { ...process.env, ACOM_HOME: home, HOME: path.join(root, 'user'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: path.join(root, 'empty-bin') };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ['serve', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; server.stderr.on('data', chunk => errors += chunk);
  const sockets = new Set();
  const raw = ({ headers = [], body, end = false, timeout = 3000 } = {}) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
    sockets.add(socket);
    let pending = '', informational = [], done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); sockets.delete(socket); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(Error(`No final HTTP response; informational=${informational.join(',')}`)), timeout);
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!done) finish(Error('Connection closed without a complete response')); });
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (;;) {
        const boundary = pending.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const head = pending.slice(0, boundary), status = Number(head.match(/^HTTP\/1\.[01] (\d+)/)?.[1]);
        if (status < 200) { informational.push(status); pending = pending.slice(boundary + 4); continue; }
        const length = Number(head.match(/\r\nContent-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isSafeInteger(length) || pending.length < boundary + 4 + length) return;
        finish(null, { status, informational, value: JSON.parse(pending.slice(boundary + 4, boundary + 4 + length)) });
        return;
      }
    });
    socket.once('connect', () => {
      socket.write(['POST /projects HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close', ...headers, '', ''].join('\r\n'));
      if (body) socket.write(body);
      if (end) socket.end();
    });
  });
  let db;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      if (server.exitCode !== null) throw Error(`Fixture exited: ${errors}`);
      try { if ((await fetch(base + '/catalog')).ok) break; } catch {}
      if (Date.now() > deadline) throw Error(`Fixture startup timed out: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    db = new DatabaseSync(path.join(home, 'acom.db'));
    const snapshot = () => Object.fromEntries(['projects', 'agents', 'configs', 'activity', 'events'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    await run({ raw, project, snapshot, base });
  } finally {
    for (const socket of sockets) socket.destroy();
    db?.close();
    if (server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM'); await stopped;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('HTTP origin and JSON media type reject before reading or inviting a body', async () => fixture(async ({ raw, snapshot }) => {
  const before = snapshot();
  for (const headers of [
    ['Origin: https://untrusted.invalid', 'Content-Type: application/json'],
    ['Content-Type: text/plain'],
    ['Content-Type: application/jsonp'],
  ]) {
    const response = await raw({ headers: [...headers, 'Content-Length: 4096', 'Expect: 100-continue'] });
    assert.equal(response.status, 403);
    assert.deepEqual(response.informational, [], 'rejected requests must not receive 100 Continue');
  }
  assert.deepEqual(snapshot(), before);
}));

test('HTTP oversized declared bodies reject immediately without consuming notifications or state', async () => fixture(async ({ raw, snapshot }) => {
  const before = snapshot();
  const response = await raw({ headers: ['Content-Type: application/json', `Content-Length: ${MAX_BODY + 1}`, 'Expect: 100-continue'] });
  assert.equal(response.status, 413);
  assert.deepEqual(response.informational, []);
  assert.match(response.value.error, /16 MiB|16777216/);
  assert.deepEqual(snapshot(), before);
}));

test('HTTP chunked bodies are capped before an unbounded stream finishes', async () => fixture(async ({ raw, snapshot, project }) => {
  const before = snapshot();
  const body = Buffer.alloc(MAX_BODY + 1, 32);
  Buffer.from(JSON.stringify({ path: project })).copy(body);
  const chunk = Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n')]);
  // Deliberately no final zero chunk: the cap must not wait for stream EOF.
  const response = await raw({ headers: ['Content-Type: application/json', 'Transfer-Encoding: chunked'], body: chunk, timeout: 10000 });
  assert.equal(response.status, 413);
  assert.deepEqual(snapshot(), before);
}));

test('HTTP valid JSON at the byte ceiling remains supported, including media type parameters', async () => fixture(async ({ raw, project }) => {
  const body = Buffer.alloc(MAX_BODY, 32);
  Buffer.from(JSON.stringify({ path: project })).copy(body);
  const response = await raw({ headers: ['Content-Type: Application/JSON; charset=utf-8', `Content-Length: ${body.length}`], body, timeout: 10000 });
  assert.equal(response.status, 200);
  assert.equal(response.value.path, project);
}));

test('HTTP incomplete or invalid UTF-8 bodies never execute otherwise valid JSON', async () => fixture(async ({ raw, project, snapshot }) => {
  const before = snapshot(), body = Buffer.from(JSON.stringify({ path: project }));
  const incomplete = await raw({ headers: ['Content-Type: application/json', `Content-Length: ${body.length + 64}`, 'Expect: 100-continue'], body, end: true });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.value.error, /incomplete|length/i);
  const invalid = await raw({ headers: ['Content-Type: application/json', 'Content-Length: 1'], body: Buffer.from([255]) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(snapshot(), before);
}));

test('HTTP truncated chunked bodies cannot commit a valid JSON prefix', async () => fixture(async ({ raw, project, snapshot }) => {
  const before = snapshot(), json = JSON.stringify({ path: project });
  for (const body of [
    `${(Buffer.byteLength(json) + 64).toString(16)}\r\n${json}`,
    `${Buffer.byteLength(json).toString(16)}\r\n${json}\r\n`,
  ]) {
    const response = await raw({ headers: ['Content-Type: application/json', 'Transfer-Encoding: chunked'], body, end: true });
    assert.equal(response.status, 400);
    assert.deepEqual(snapshot(), before);
  }
  const pieces = [json.slice(0, 9), json.slice(9)];
  const body = pieces.map(piece => `${Buffer.byteLength(piece).toString(16)}\r\n${piece}\r\n`).join('') + '0\r\n\r\n';
  const complete = await raw({ headers: ['Content-Type: application/json', 'Transfer-Encoding: chunked'], body });
  assert.equal(complete.status, 200);
  assert.equal(complete.value.path, project);
}));
