import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TECH_TABS, buildSnapshot } from '../server/modules/technical/model.js';
import { createTechnicalStore } from '../server/modules/technical/store.js';
import { createTechnicalPushReceiver } from '../server/modules/technical/push.js';
import { technicalSyncHealth } from '../server/modules/technical/sync-health.js';
import { createTechnicalModule } from '../server/modules/technical/index.js';

const base = Date.parse('2026-11-17T12:00:00.000Z');
const at = (minutes) => new Date(base + minutes * 60_000).toISOString();
const id = (num) => `aabbccdd-eeee-4fff-8aaa-${String(num).padStart(12, '0')}`;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = createTechnicalStore(db);
  const grids = Object.fromEntries(TECH_TABS.map((tab) => [tab.title, [['Тестовые заголовки']]]));
  const row = Array(26).fill(''); row[1] = 'X2601'; row[2] = 'ООО Проверка';
  const accountant = [Array(26).fill('Заголовок'), row];
  const sources = {accounting: accountant, ...Object.fromEntries(TECH_TABS.map((tab) => [`workbook:${tab.id}`, grids[tab.title]]))};
  return { db, store, sources, grids, accountant };
}
function save(f, timestamp, flags) {
  f.store.commitSnapshot(buildSnapshot(f.grids, f.accountant, timestamp), f.sources, flags);
}

test('no source, no initial date: waiting instead of fabricated green health', () => {
  const f = fixture();
  try {
    const state = technicalSyncHealth(f.store, 'apps-script', base);
    assert.equal(state.level, 'pending');
    assert.equal(state.lastReconcileAt, null);
    assert.equal(state.ageMinutes, null);
    assert.equal(technicalSyncHealth(f.store, 'none', base).level, 'disabled');
  } finally { f.db.close(); }
});

test('successful full accounting reconciliation is recorded and fresh under threshold', () => {
  const f = fixture();
  try {
    save(f, at(0), {accountingReconciled: true});
    const state = technicalSyncHealth(f.store, 'apps-script', base + 19 * 60_000);
    assert.equal(state.level, 'ok');
    assert.equal(state.lastReconcileAt, at(0));
    assert.equal(state.lastChangeAt, at(0));
    assert.equal(state.ageMinutes, 19);
    assert.equal(state.staleAfterMinutes, 20);
  } finally { f.db.close(); }
});

test('no accounting reconciliation for 20 minutes produces warning even when site remains available', () => {
  const f = fixture();
  try {
    save(f, at(0), {accountingReconciled: true});
    assert.equal(technicalSyncHealth(f.store, 'apps-script', base + 20 * 60_000 - 1).level, 'ok');
    assert.equal(technicalSyncHealth(f.store, 'apps-script', base + 20 * 60_000).level, 'stale');
  } finally { f.db.close(); }
});

test('technical-only and accounting-row edits do not forge full reconciliation heartbeat', () => {
  const f = fixture();
  try {
    save(f, at(0), {accountingReconciled: true});
    f.store.addNote(TECH_TABS[0].id, 'code:X2601', 'Храним заметки сотрудников', {login:'self-reported', name:'Техник'});
    save(f, at(18), {}); // technical-only update
    save(f, at(21), {accountingUpdated: true}); // individual accountant cell edit
    const state = technicalSyncHealth(f.store, 'apps-script', base + 22 * 60_000);
    assert.equal(state.level, 'stale', 'row patches cannot mask a stopped 5-minute reconciliation');
    assert.equal(state.lastChangeAt, at(21));
    assert.equal(state.lastReconcileAt, at(0));
    assert.equal(f.store.recordDetail(TECH_TABS[0].id, 'code:X2601').notes[0].body, 'Храним заметки сотрудников');
  } finally { f.db.close(); }
});

test('explicit source error persists across row patches and clears after a successful full reconciliation', () => {
  const f = fixture();
  try {
    save(f, at(0), {accountingReconciled: true});
    f.store.setMeta('accountingLastError', 'Источник не ответил');
    f.store.setMeta('accountingLastErrorAt', at(2));
    save(f, at(3), {accountingUpdated: true});
    const bad = technicalSyncHealth(f.store, 'apps-script', base + 4 * 60_000);
    assert.equal(bad.level, 'error');
    assert.equal(bad.lastError, 'Источник не ответил');
    save(f, at(5), {accountingReconciled: true});
    const good = technicalSyncHealth(f.store, 'apps-script', base + 6 * 60_000);
    assert.equal(good.level, 'ok');
    assert.equal(good.lastError, null);
  } finally {f.db.close();}
});

test('existing old snapshot is not presented as a confirmed reconciliation', () => {
  const f = fixture();
  try {
    save(f, at(0), {});
    const pending = technicalSyncHealth(f.store, 'apps-script', base + 2 * 60_000);
    assert.equal(pending.level, 'pending');
    assert.equal(pending.lastReconcileAt, null);
    assert.equal(technicalSyncHealth(f.store, 'apps-script', base + 21 * 60_000).level, 'stale');
  } finally {f.db.close();}
});

test('success markers are persisted in SQLite across store object rebuilds', () => {
  const f = fixture();
  try {
    save(f, at(0), {accountingReconciled: true});
    const reopened = createTechnicalStore(f.db);
    assert.equal(technicalSyncHealth(reopened, 'apps-script', base + 1000).level, 'ok');
  } finally {f.db.close();}
});

test('API meta provides live source-health fields through existing authenticated endpoint', () => {
  const f = fixture();
  const service = createTechnicalModule(f.db,{technicalEnv:{TECH_PUSH_IMPORT_TOKEN:'x'.repeat(64)},disableTechnicalStartupSync:true});
  const routes = new Map();
  service.registerRoutes({
    get(path, handler){routes.set(path,handler);}, post(){}, patch(){}, delete(){}
  });
  try {
    save(f, new Date().toISOString(), {accountingReconciled: true});
    let response;
    routes.get('/api/technical/meta')({}, {json(value){response=value;}});
    assert.equal(response.syncHealth.level, 'ok');
    assert.equal(response.syncHealth.lastReconcileAt, f.store.meta('accountingLastReconcileAt'));
    assert.equal(response.source.includes('Apps Script'), true);
  } finally {service.stop();f.db.close();}
});

test('authenticated malformed reconciliation reports a sanitised error, rejected token never changes health', () => {
  const f=fixture();
  const secret='z'.repeat(64);
  const service=createTechnicalModule(f.db,{technicalEnv:{TECH_PUSH_IMPORT_TOKEN:secret},disableTechnicalStartupSync:true});
  const routes=new Map(); service.registerPushHooks({post(path,handler){routes.set(path,handler);}});
  try {
    save(f, new Date().toISOString(), {accountingReconciled:true});
    const req = (token,body) => {
      let code=200;
      const res={status(num){code=num;return this;},json(value){return {code,body:value};}};
      return routes.get('/hooks/technical/import/accounting/start')({
        headers:{authorization:'Bearer '+token, 'content-type':'application/json'},body
      },res);
    };
    assert.equal(req('wrong',{runId:id(1),expected:0}).code,403);
    assert.equal(f.store.meta('accountingLastError'),null);
    assert.equal(req(secret,{runId:id(1),expected:0}).code,400);
    assert.match(f.store.meta('accountingLastError'),/Неверное число частей/);
    assert.equal(technicalSyncHealth(f.store,'apps-script').level,'error');
  } finally {service.stop();f.db.close();}
});

test('benign 409 overlap cannot trigger a false error warning', () => {
  const f=fixture();
  const secret='z'.repeat(64);
  const service=createTechnicalModule(f.db,{technicalEnv:{TECH_PUSH_IMPORT_TOKEN:secret},disableTechnicalStartupSync:true});
  const routes=new Map(); service.registerPushHooks({post(path,handler){routes.set(path,handler);}});
  try {
    save(f, new Date().toISOString(), {accountingReconciled:true});
    const respond=(action,body)=>{
      let code=200;
      return routes.get('/hooks/technical/import/'+action)({
        headers:{authorization:'Bearer '+secret, 'content-type':'application/json'},body
      }, {status(n){code=n;return this;},json(v){return {code,body:v};}});
    };
    const counts={accounting:1,...Object.fromEntries(TECH_TABS.map(x=>['workbook:'+x.id,1]))};
    assert.equal(respond('start',{runId:id(3),expected:counts}).code,200);
    assert.equal(respond('accounting/start',{runId:id(4),expected:1}).code,409);
    assert.equal(f.store.meta('accountingLastError'),null);
  } finally {service.stop();f.db.close();}
});

