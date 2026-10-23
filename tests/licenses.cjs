// Offline notices and generator checks. ACOM_BINARY selects an isolated build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const binary = process.env.ACOM_BINARY || path.join(repository, 'target/debug/acom');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const embeddedNotices = () => Buffer.concat([
  fs.readFileSync(path.join(repository, 'LICENSE')), Buffer.from('\n'),
  fs.readFileSync(path.join(repository, 'THIRD_PARTY_NOTICES.txt')),
]);

function invoke(args, env, cwd, firstLine = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = '', closed = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', chunk => {
      if (closed) return;
      stdout = Buffer.concat([stdout, chunk]);
      const newline = stdout.indexOf(10);
      if (firstLine && newline >= 0) {
        stdout = stdout.subarray(0, newline + 1);
        closed = true;
        child.stdout.destroy();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function isolatedCli(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-licenses-test-'));
  const taskHome = path.join(root, 'home'), cwd = path.join(root, 'unrelated'), bin = path.join(root, 'bin');
  for (const dir of [taskHome, cwd, bin]) fs.mkdirSync(dir);
  const requests = [];
  const canary = http.createServer((request, response) => {
    requests.push([request.method, request.url]);
    request.resume(); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: 'The notices command must not contact a server' }));
  });
  await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve));
  const env = {
    HOME: taskHome, PATH: bin, LC_ALL: 'C.UTF-8', RUST_BACKTRACE: '1',
    ACOM_HOME: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    ACOM_URL: `http://127.0.0.1:${canary.address().port}`,
  };
  try {
    await run({ env, cwd, requests });
    assert.deepEqual(requests, [], 'offline commands do not contact the acom server');
    assert.deepEqual(fs.readdirSync(root).sort(), ['bin', 'home', 'unrelated'], 'offline commands create no state or provider directories');
    assert.deepEqual(fs.readdirSync(taskHome), []);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    canary.closeAllConnections();
    await new Promise(resolve => canary.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('licenses prints exact embedded notices offline without creating state', async () => isolatedCli(async ({ env, cwd }) => {
  const result = await invoke(['licenses'], env, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const expected = embeddedNotices();
  assert.deepEqual(result.stdout, expected, 'printing neither adds nor removes a trailing newline');
  const markdown = fs.readFileSync(path.join(repository, 'src/vendor/NOTICES.txt'), 'utf8');
  assert.ok(result.stdout.toString('utf8').includes(markdown.trimEnd()), 'existing Markdown dependency notices remain included');
}));

test('licenses is discoverable in global and command help without a server', async () => isolatedCli(async ({ env, cwd }) => {
  const general = await invoke(['--help'], env, cwd);
  assert.equal(general.status, 0, general.stderr);
  assert.match(general.stdout.toString('utf8'), /\blicenses\b/);
  const command = await invoke(['licenses', '--help'], env, cwd);
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout.toString('utf8'), /Usage: acom licenses/);
  assert.equal(command.stderr, '');
}));

test('licenses rejects unknown flags and positional arguments without state changes', async () => isolatedCli(async ({ env, cwd }) => {
  for (const argument of ['--invented', '--catalog', 'unexpected']) {
    const result = await invoke(['licenses', argument], env, cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected argument/i);
    assert.ok(result.stderr.includes(argument));
    assert.equal(result.stdout.length, 0, 'invalid invocations never print notices as a success');
  }
}));

test('licenses exits quietly when a reader closes stdout after the first line', async () => isolatedCli(async ({ env, cwd }) => {
  const result = await invoke(['licenses'], env, cwd, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', 'EPIPE must not panic or print a backtrace');
  const expected = embeddedNotices();
  assert.deepEqual(result.stdout, expected.subarray(0, expected.indexOf(10) + 1));
}));

function snapshot(root) {
  const result = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      const stat = fs.statSync(file, { bigint: true });
      result[relative] = [entry.isDirectory() ? 'directory' : digest(fs.readFileSync(file)), stat.mode.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root);
  return result;
}

function generatorFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-license-generator-'));
  const write = (relative, value, options) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, options);
  };
  try {
    write('scripts/licenses.cjs', fs.readFileSync(path.join(repository, 'scripts/licenses.cjs')));
    write('LICENSE', fs.readFileSync(path.join(repository, 'LICENSE')));
    const manifest = '[package]\nname = "acom"\nversion = "0.1.0"\nedition = "2024"\n';
    write('Cargo.toml', manifest);
    const lock = 'version = 4\n\n[[package]]\nname = "acom"\nversion = "0.1.0"\n\n[[package]]\nname = "fixture-arm"\nversion = "1.0.0"\n\n[[package]]\nname = "fixture-x86"\nversion = "1.0.0"\n';
    write('Cargo.lock', lock);
    const markdown = 'Fixture Markdown notices\nCopyright fixture renderer\n';
    write('src/vendor/NOTICES.txt', markdown);
    const targets = ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'];
    const inventory = { targets, lock_sha256: digest(lock), manifest_sha256: digest(manifest), packages: [] };
    const metadata = { root, targets: {} };
    const own = { id: 'path+fixture#acom@0.1.0', name: 'acom', version: '0.1.0', license: 'MIT', manifest_path: path.join(root, 'Cargo.toml') };
    const packages = [own];
    for (const name of ['fixture-arm', 'fixture-x86']) {
      const directory = `crates/${name}`, license = `Copyright fixture ${name}\n\nPermission is hereby granted to use this fixture.\n`;
      const header = '// Copyright fixture contributor\n// SPDX-License-Identifier: MIT\n';
      write(`${directory}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "1.0.0"\nlicense = "MIT"\n`);
      write(`${directory}/LICENSE-MIT`, license);
      write(`${directory}/src/lib.rs`, `${header}pub fn fixture() {}\n`);
      inventory.packages.push({
        name, version: '1.0.0', license: 'MIT', selected: 'MIT', files: ['LICENSE-MIT'],
        file_sha256: { 'LICENSE-MIT': digest(license) },
        headers: [{ file: 'src/lib.rs', start: 1, end: 2, sha256: digest(header) }],
      });
      packages.push({ id: `registry+fixture#${name}@1.0.0`, name, version: '1.0.0', license: 'MIT', manifest_path: path.join(root, directory, 'Cargo.toml') });
    }
    for (const target of targets) metadata.targets[target] = { packages, resolve: { root: own.id, nodes: packages.map(pkg => ({ id: pkg.id })) } };
    write('licenses/rust.json', JSON.stringify(inventory));
    write('metadata.json', JSON.stringify(metadata));
    write('bin/cargo', `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2), data = JSON.parse(fs.readFileSync(process.env.FIXTURE_CARGO_METADATA));\nif (args[0] !== 'metadata' || !args.includes('--locked') || !args.includes('--offline') || args[args.indexOf('--format-version') + 1] !== '1' || process.cwd() !== data.root) process.exit(3);\nconst target = args[args.indexOf('--filter-platform') + 1];\nif (!data.targets[target]) process.exit(4);\nprocess.stdout.write(JSON.stringify(data.targets[target]));\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'unrelated'));
    const env = {
      HOME: path.join(root, 'home'), PATH: path.join(root, 'bin'), LC_ALL: 'C.UTF-8',
      CARGO_NET_OFFLINE: 'true', FIXTURE_CARGO_METADATA: path.join(root, 'metadata.json'),
    };
    const command = args => spawnSync(process.execPath, [path.join(root, 'scripts/licenses.cjs'), ...args], {
      env, cwd: path.join(root, 'unrelated'), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    });
    const generated = command(['--write']);
    assert.equal(generated.status, 0, generated.stderr);
    run({ root, write, inventory, markdown, command });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('license generator default and explicit checks are offline and read-only', () => generatorFixture(({ root, markdown, command }) => {
  const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.ok(notice.includes(markdown), 'the existing Markdown notices are included verbatim');
  for (const name of ['fixture-arm', 'fixture-x86']) assert.ok(notice.includes(name), 'both platform inventories are included');
  assert.ok(!notice.includes(root), 'machine-specific source paths do not enter distributed notices');
  const before = snapshot(root);
  for (const args of [[], ['--check']]) {
    const result = command(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(root), before, 'check mode must not rewrite even identical bytes');
  }
}));

const staleInputs = {
  'Cargo.lock': ({ root }) => fs.appendFileSync(path.join(root, 'Cargo.lock'), '# unreviewed lock change\n'),
  'Cargo.toml features': ({ root }) => fs.appendFileSync(path.join(root, 'Cargo.toml'), '\n[features]\nunreviewed = []\n'),
  inventory: ({ write, inventory }) => { inventory.packages[0].version = '9.9.9'; write('licenses/rust.json', JSON.stringify(inventory)); },
  'dependency license': ({ root }) => fs.appendFileSync(path.join(root, 'crates/fixture-arm/LICENSE-MIT'), 'Unreviewed license change\n'),
  'dependency attribution header': ({ write }) => write('crates/fixture-arm/src/lib.rs', '// Changed copyright\n// SPDX-License-Identifier: MIT\npub fn fixture() {}\n'),
  'unsafe inventory path': ({ write, inventory }) => { inventory.packages[0].files = ['../LICENSE-MIT']; inventory.packages[0].file_sha256 = { '../LICENSE-MIT': '0'.repeat(64) }; write('licenses/rust.json', JSON.stringify(inventory)); },
};
for (const [name, tamper] of Object.entries(staleInputs)) test(`license generator rejects unreviewed ${name} without writes`, () => generatorFixture(fixture => {
  tamper(fixture);
  const before = snapshot(fixture.root);
  for (const mode of ['--check', '--write']) {
    const result = fixture.command([mode]);
    assert.notEqual(result.status, 0, `${mode} must reject unreviewed ${name}`);
    assert.ok(result.stderr.trim(), 'rejection explains the failed validation');
    assert.deepEqual(snapshot(fixture.root), before, 'failed checks and generation must not modify inputs or existing notices');
  }
}));

test('license generator detects stale notices without silently regenerating them', () => generatorFixture(({ root, command }) => {
  fs.appendFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'Tampered notice\n');
  const before = snapshot(root), result = command(['--check']);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.trim());
  assert.deepEqual(snapshot(root), before);
}));

test('license generator rejects unknown and conflicting arguments without writes', () => generatorFixture(({ root, command }) => {
  const before = snapshot(root);
  for (const args of [['--unknown'], ['--check', '--write'], ['unexpected']]) {
    const result = command(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage|argument|option|flag/i);
    assert.deepEqual(snapshot(root), before);
  }
}));
