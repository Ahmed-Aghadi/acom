// Generate the reviewed dependency notices without installing or executing packages.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const keys = (value, allowed, label) => {
  check(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  for (const key of Object.keys(value)) check(allowed.includes(key), `Unknown ${label} field: ${key}`);
};
function source(directory, relative) {
  check(typeof relative === 'string' && relative.length && !path.isAbsolute(relative) && !relative.includes('\\') && relative.split('/').every(part => part && !['.', '..'].includes(part)), `Invalid notice path: ${relative}`);
  const file = fs.realpathSync(path.join(directory, relative));
  check(file.startsWith(fs.realpathSync(directory) + path.sep), `Notice path escapes its package: ${relative}`);
  return fs.readFileSync(file);
}
function verified(bytes, expected, label) {
  check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && digest(bytes) === expected, `Reviewed content changed: ${label}; review the source and inventory before regenerating`);
  return bytes.toString('utf8');
}
function metadata(target) {
  const result = spawnSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target], {cwd:root, encoding:'utf8', maxBuffer:16 * 1024 * 1024});
  if (result.error || result.status !== 0) fail(`Cannot read locked offline Cargo metadata for ${target}: ${result.error?.message || result.stderr.trim()}`);
  const data = JSON.parse(result.stdout), resolved = new Set(data.resolve.nodes.map(node => node.id));
  return data.packages.filter(pkg => resolved.has(pkg.id) && pkg.id !== data.resolve.root);
}
function generate() {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'licenses/rust.json'), 'utf8'));
  keys(inventory, ['targets', 'lock_sha256', 'manifest_sha256', 'packages'], 'inventory');
  const lock = fs.readFileSync(path.join(root, 'Cargo.lock'));
  verified(lock, inventory.lock_sha256, 'Cargo.lock');
  verified(fs.readFileSync(path.join(root, 'Cargo.toml')), inventory.manifest_sha256, 'Cargo.toml');
  check(Array.isArray(inventory.targets) && inventory.targets.length && inventory.targets.every(target => typeof target === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(target)), 'Inventory needs explicit reviewed targets');
  check(new Set(inventory.targets).size === inventory.targets.length, 'Duplicate inventory target');
  check(Array.isArray(inventory.packages) && inventory.packages.length, 'Inventory needs reviewed packages');
  const reviewed = new Map();
  for (const pkg of inventory.packages) {
    keys(pkg, ['name', 'version', 'license', 'selected', 'files', 'file_sha256', 'headers', 'note'], 'package');
    for (const field of ['name', 'version', 'license', 'selected']) check(typeof pkg[field] === 'string' && pkg[field].length, `Missing reviewed package ${field}`);
    const id = `${pkg.name}@${pkg.version}`;
    check(!reviewed.has(id), `Duplicate reviewed package: ${id}`);
    check(Array.isArray(pkg.files) && pkg.files.length && new Set(pkg.files).size === pkg.files.length, `Missing or duplicate notice files for ${id}`);
    keys(pkg.file_sha256, pkg.files, `${id} file hashes`);
    check(pkg.headers === undefined || Array.isArray(pkg.headers), `Invalid source headers for ${id}`);
    check(pkg.note === undefined || (typeof pkg.note === 'string' && pkg.note.length), `Invalid license note for ${id}`);
    reviewed.set(id, pkg);
  }
  let packages;
  for (const target of inventory.targets) {
    const resolved = metadata(target), ids = new Set();
    for (const pkg of resolved) {
      const id = `${pkg.name}@${pkg.version}`, entry = reviewed.get(id);
      check(!ids.has(id), `Ambiguous resolved package: ${id}`);
      ids.add(id);
      check(entry && entry.license === pkg.license, `Unreviewed dependency or license for ${target}: ${id}`);
    }
    for (const id of reviewed.keys()) check(ids.has(id), `Stale inventory dependency for ${target}: ${id}`);
    packages ||= resolved;
  }
  const chunks = [
    'Third-party notices for acom\n============================',
    "acom's own source is MIT-licensed (see LICENSE). Third-party components retain the terms below.\n" +
    `Reviewed Cargo targets: ${inventory.targets.join(', ')}.\n` +
    `Cargo.lock SHA-256: ${inventory.lock_sha256}.\n` +
    `Cargo.toml SHA-256: ${inventory.manifest_sha256}.\n` +
    'Build-time dependencies and bundled dependency source are included conservatively; not all are linked.\n' +
    'Rust toolchain/standard-library and separately supplied system-library notices are outside this inventory.\n' +
    'Before publishing binaries, include the matching toolchain/platform notices for that release.\n' +
    'Check with node scripts/licenses.cjs --check; regenerate after review with --write.',
  ];
  packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`, entry = reviewed.get(id), directory = path.dirname(pkg.manifest_path);
    chunks.push(`${pkg.name} ${pkg.version}\nUpstream license: ${entry.license}\nSelected terms: ${entry.selected}\nSource: https://crates.io/crates/${pkg.name}/${pkg.version}${entry.note ? `\n${entry.note}` : ''}`);
    for (const file of entry.files) chunks.push(`${file}\n${'-'.repeat(40)}\n${verified(source(directory, file), entry.file_sha256[file], `${id}/${file}`).trimEnd()}`);
    for (const header of entry.headers || []) {
      keys(header, ['file', 'start', 'end', 'sha256'], 'source header');
      const lines = source(directory, header.file).toString('utf8').split('\n');
      check(Number.isSafeInteger(header.start) && Number.isSafeInteger(header.end) && header.start > 0 && header.end >= header.start && header.end <= lines.length, `Invalid source-header range for ${id}/${header.file}`);
      const text = lines.slice(header.start - 1, header.end).join('\n') + '\n';
      chunks.push(`${header.file}:${header.start}-${header.end}\n${'-'.repeat(40)}\n${verified(text, header.sha256, `${id}/${header.file} header`).trimEnd()}`);
    }
  }
  chunks.push('Bundled browser Markdown components\n===================================', fs.readFileSync(path.join(root, 'src/vendor/NOTICES.txt'), 'utf8').trimEnd());
  return chunks.map(chunk => chunk.replace(/\r\n/g, '\n').trimEnd()).join('\n\n') + '\n';
}

try {
  const args = process.argv.slice(2);
  check(args.length <= 1 && (!args.length || ['--check', '--write', '--help'].includes(args[0])), 'Usage: node scripts/licenses.cjs [--check|--write]');
  if (args[0] === '--help') {
    console.log('Usage: node scripts/licenses.cjs [--check|--write]\nDefault: check reviewed dependency coverage and generated notices, without writing.');
  } else {
    const text = generate(), output = path.join(root, 'THIRD_PARTY_NOTICES.txt');
    if (args[0] === '--write') {
      fs.writeFileSync(output, text);
      console.log('Wrote THIRD_PARTY_NOTICES.txt');
    } else {
      check(fs.existsSync(output) && fs.readFileSync(output, 'utf8') === text, 'THIRD_PARTY_NOTICES.txt is stale; review dependencies and run node scripts/licenses.cjs --write');
      console.log('Third-party notices match the reviewed inventory and locked dependency tree.');
    }
  }
} catch (error) {
  console.error(`License check failed: ${error.message}`);
  process.exitCode = 1;
}
