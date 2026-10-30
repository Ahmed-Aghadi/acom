// Test-only path helpers. Production never translates old project or agent IDs.
const assert = require('node:assert/strict');
const path = require('node:path');

const local = /^\/(?:agents|agent-config|threads|messages|inbox|marks|locks|activity|history|notices|subscriptions|wait|hook|receipts|settings|limits|controls|drafts)(?:\/|\?|$)/;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function scoped(route, project, body) {
  if (!local.test(route)) return route;
  const url = new URL(route, 'http://fixture');
  const explicit = body?.project ?? url.searchParams.get('project');
  if (uuid(explicit)) project = explicit;
  assert.ok(uuid(project), `local fixture request needs an explicit project: ${route}`);
  return `/p/${project}${route}`;
}

const projectHome = (home, project) => {
  assert.ok(uuid(project), 'fixture project identity must be a UUID');
  return path.join(home, 'projects', project);
};
function attachGlobal(connection, home) {
  connection.exec('PRAGMA busy_timeout=5000');
  connection.prepare('ATTACH DATABASE ? AS global').run(path.join(home, 'global', 'shared.db'));
}

module.exports = { scoped, projectHome, attachGlobal };
