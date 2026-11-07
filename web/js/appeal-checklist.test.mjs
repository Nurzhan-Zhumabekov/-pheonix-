import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

globalThis.window = {};
const browserModules = new Set(['api.js', 'config.js'].map(file => new URL(file, import.meta.url).href));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return browserModules.has(resolved.url) ? { ...resolved, format: 'module' } : resolved;
  },
});
const { api } = await import('./api.js');
hooks.deregister();

const appeal = { conversation_id: 'dialog/1', evaluation_id: 'eval-original' };
const evaluationPath = '/api/evaluations/dialog%2F1';
const archivedPath = '/api/checklists/2';
const evaluation = { evaluation_id: 'eval-original', checklist_version: 2 };
const archived = { version: 2, criteria: [{ id: 'removed', type: 'scale', scale: [0, 5, 10] }] };

test('appeal loads its archived rubric and preserves criteria removed from the current rubric', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (path) => Response.json({
    [evaluationPath]: evaluation,
    [archivedPath]: archived,
    '/api/checklist': { version: 3, criteria: [] },
  }[path]));

  assert.deepEqual(await api.getAppealChecklist(appeal), archived);
  assert.deepEqual(fetch.mock.calls.map(({ arguments: args }) => args[0]), [evaluationPath, archivedPath]);
});

test('legacy appeals without an evaluation ID use the saved evaluation version', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === evaluationPath ? evaluation : archived));

  assert.deepEqual(await api.getAppealChecklist({ conversation_id: appeal.conversation_id }), archived);
});

test('an unavailable archive never falls back to the current rubric', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (path) => path === evaluationPath
    ? Response.json(evaluation)
    : Response.json({ error: { code: 'no_checklist_version' } }, { status: 404 }));

  assert.equal(await api.getAppealChecklist(appeal), null);
  assert.deepEqual(fetch.mock.calls.map(({ arguments: args }) => args[0]), [evaluationPath, archivedPath]);
});

test('an appeal tied to a replaced evaluation cannot use the replacement rubric', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ evaluation_id: 'eval-replacement', checklist_version: 3 }));

  assert.equal(await api.getAppealChecklist(appeal), null);
  assert.equal(fetch.mock.callCount(), 1);
});
