import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTechnicalModule } from '../server/modules/technical/index.js';
import { buildSnapshot, TECH_TABS } from '../server/modules/technical/model.js';

const ACCOUNTING = TECH_TABS[0].id;
const accountingRow = () => {
  const values = Array(33).fill('');
  values[1] = 'D240'; values[2] = 'ООО ФИССМАН';
  values[15] = 'АНАПА'; values[16] = 'Магазин';
  values[20] = '2200';
  return values;
};
const workbook = () => Object.fromEntries(TECH_TABS.map(t => {
  const row = Array(30).fill('');
  if (t.id === ACCOUNTING) { row[6] = 'D240'; row[3] = 'исходный комментарий'; row[17] = '1700'; }
  else row[0] = 'рабочая запись';
  return [t.title, [Array(30).fill('Поле'), row]];
}));

function stubRoutes(module) {
  const routes = { get: new Map(), post: new Map(), patch: new Map(), delete: new Map() };
  for (const method of Object.keys(routes)) {
    routes[method].set = routes[method].set.bind(routes[method]);
  }
  module.registerRoutes({
    get: (path, ...handlers) => routes.get.set(path, handlers),
    post: (path, ...handlers) => routes.post.set(path, handlers),
    patch: (path, ...handlers) => routes.patch.set(path, handlers),
    delete: (path, ...handlers) => routes.delete.set(path, handlers),
  });
  return routes;
}
async function perform(routes, method, path, body, id = ACCOUNTING, key = 'code:D240') {
  const handlers = routes[method].get(path);
  assert.ok(handlers, `route ${method} ${path} must exist`);
  const request = { params: { id, key }, body };
  let result;
  let forwarded;
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(obj) { result = { status: this.statusCode, body: obj }; return this; } };
  for (const handler of handlers) {
    await new Promise((resolve) => {
      const next = (error) => { forwarded = error; resolve(); };
      try {
        const maybe = handler(request, response, next);
        if (maybe && typeof maybe.then === 'function') maybe.then(resolve, next);
        else resolve();
      } catch (error) { forwarded = error; resolve(); }
    });
    if (forwarded || result) break;
  }
  return { result, forwarded };
}

test('technical module works with existing workspace session; no second login route', async () => {
  const db = new DatabaseSync(':memory:');
  const module = createTechnicalModule(db, { technicalEnv: {TECH_PUSH_IMPORT_TOKEN: 'a'.repeat(64)}, disableTechnicalStartupSync: true });
  try {
    module.store.commitSnapshot(buildSnapshot(workbook(), [['Код'], accountingRow()]));
    const routes = stubRoutes(module);
    assert.equal(routes.post.has('/api/technical/login'), false);
    assert.equal(routes.post.has('/api/technical/logout'), false);
    assert.equal(routes.get.has('/api/technical/session'), false);
    const path = '/api/technical/tabs/:id/rows/:key/notes';
    let answer = await perform(routes, 'post', path, { body: 'Согласован выезд', author: '  Ирина   С. ' });
    assert.equal(answer.result?.status, 201);
    assert.equal(answer.result?.body.authorName, 'Ирина С.');
    answer = await perform(routes, 'post', path, { body: 'Без подписи сотрудника', author: '' });
    assert.equal(answer.result?.status, 201);
    assert.equal(answer.result?.body.authorName, 'Без подписи');
    assert.equal(module.store.recordDetail(ACCOUNTING, 'code:D240').notes.length, 2);
  } finally { module.stop(); db.close(); }
});

test('manually specified author is stored for edits but locked accounting cells stay locked', async () => {
  const db = new DatabaseSync(':memory:');
  const module = createTechnicalModule(db, { technicalEnv: {TECH_PUSH_IMPORT_TOKEN:'b'.repeat(64)}, disableTechnicalStartupSync: true });
  try {
    const snap = buildSnapshot(workbook(), [['Код'], accountingRow()]);
    module.store.commitSnapshot(snap);
    const routes = stubRoutes(module);
    const path = '/api/technical/tabs/:id/rows/:key/cells';
    let result = await perform(routes, 'patch', path, { columnIndex: 3, value: 'В работе', author: 'Техник' });
    assert.equal(result.result?.status, 200);
    assert.equal(result.result?.body.authorName, 'Техник');
    const denied = await perform(routes, 'patch', path, { columnIndex:17, value:'1', author:'Техник' });
    assert.equal(denied.forwarded?.status, 403);
    const tooLong = await perform(routes, 'patch', path, { columnIndex:3, value:'Тест', author:'x'.repeat(81) });
    assert.equal(tooLong.forwarded?.status, 400);
    const updatedAccounting = accountingRow();
    updatedAccounting[20] = '4500';
    const reimport = buildSnapshot(workbook(), [['Код'], updatedAccounting]);
    module.store.commitSnapshot(reimport);
    const detail = module.store.recordDetail(ACCOUNTING, 'code:D240');
    assert.equal(detail.accounting.monthlyCost, '4500');
    assert.equal(detail.values[17], '4500');
    assert.equal(detail.values[3], 'В работе');
    assert.equal(detail.changes[0].authorName, 'Техник');
  } finally { module.stop(); db.close(); }
});
