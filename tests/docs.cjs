// Local documentation checks only; no server, providers or network access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const markdown = require('../src/vendor/markdown-it-15.0.3.min.js')();

const root = path.resolve(__dirname, '..');
const inside = file => file === root || file.startsWith(root + path.sep);
const label = file => path.relative(root, file);

function documents(directory, recursive = true) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? documents(file) : [];
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

const files = [...documents(root, false), ...['docs', 'src', 'vendor'].flatMap(dir => documents(path.join(root, dir)))];
const parsed = new Map(files.map(file => {
  assert.ok(inside(fs.realpathSync(file)), `Markdown source escapes repository: ${label(file)}`);
  return [file, markdown.parse(fs.readFileSync(file, 'utf8'), {})];
}));

function headings(tokens) {
  const result = new Set();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'heading_open') continue;
    const text = tokens[index + 1].children.filter(token => ['text', 'code_inline', 'image'].includes(token.type)).map(token => token.content).join('');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base, suffix = 0;
    while (result.has(slug)) slug = `${base}-${++suffix}`;
    result.add(slug);
  }
  return result;
}

function links(tokens) {
  return tokens.flatMap(token => {
    const destination = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null;
    return [...(destination === null ? [] : [destination]), ...links(token.children || [])];
  });
}

test('documentation checks understand reference links, code headings and duplicate anchors', () => {
  const tokens = markdown.parse('# A `command`\n# A command\n\n[Reference][target]\n![Screenshot][image]\n\n`[Example](missing.md)`\n\n```md\n[Example](missing.md)\n```\n\n[target]: docs/usage.md#threads-and-messages\n[image]: docs/images/overview.png\n', {});
  assert.deepEqual([...headings(tokens)], ['a-command', 'a-command-1']);
  assert.deepEqual(links(tokens), ['docs/usage.md#threads-and-messages', 'docs/images/overview.png']);
});

test('local Markdown links and heading anchors stay within the repository and resolve', () => {
  let checked = 0;
  for (const [source, tokens] of parsed) {
    for (const destination of links(tokens)) {
      if (/^(?:https?:|mailto:|\/\/)/i.test(destination)) continue;
      const [address, fragment] = destination.split('#', 2);
      const relative = decodeURIComponent(address.split('?', 1)[0]);
      const target = relative ? path.resolve(path.dirname(source), relative) : source;
      const context = `${label(source)} → ${destination}`;
      assert.ok(!path.isAbsolute(relative) && !/^[a-z][a-z0-9+.-]*:/i.test(relative), `Expected a portable relative link: ${context}`);
      assert.ok(inside(target), `Link escapes repository: ${context}`);
      assert.ok(fs.existsSync(target), `Missing local target: ${context}`);
      assert.ok(inside(fs.realpathSync(target)), `Link follows a symlink outside repository: ${context}`);
      if (fragment && target.endsWith('.md')) {
        assert.ok(headings(parsed.get(target) || markdown.parse(fs.readFileSync(target, 'utf8'), {})).has(decodeURIComponent(fragment)), `Missing heading anchor: ${context}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, 'Expected the public documentation links to be checked');
});

test('README screenshots are local PNGs rather than remote or machine-specific resources', () => {
  const images = parsed.get(path.join(root, 'README.md')).flatMap(token => (token.children || []).filter(child => child.type === 'image').map(child => child.attrGet('src')));
  assert.ok(images.length >= 2, 'README should show the actual interface');
  for (const image of images) {
    assert.match(image, /^docs\/images\/[a-z0-9-]+\.png$/);
    const file = path.join(root, image);
    assert.ok(inside(fs.realpathSync(file)), `Screenshot escapes repository: ${image}`);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `Not a PNG: ${image}`);
  }
});
