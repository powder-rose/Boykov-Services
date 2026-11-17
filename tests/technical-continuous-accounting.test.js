import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TECH_TABS, buildSnapshot, canEditColumn } from '../server/modules/technical/model.js';
import { createTechnicalStore } from '../server/modules/technical/store.js';
import { createTechnicalPushReceiver } from '../server/modules/technical/push.js';
const main = TECH_TABS[0];
function fixture(newObject = false) {
  const sheet = Array.from({ length: 30 }, (_, index) => `Колонка ${index + 1}`);
  const old = Array(30).fill('');old[6] = 'D240';old[7] = 'Компания';old[3] = 'Рабочая заметка';
  const work = Object.fromEntries(TECH_TABS.map((tab) =>
    [tab.title, tab.id === main.id ? [sheet, old] : [Array(30).fill('Заголовок')]]));
  const header = Array(33).fill('Заголовок');
  const account = Array(33).fill('');account[1] = 'D240';account[2] = 'Компания';account[20] = '2200';
  const result = [header, account];
  if (newObject) {
    const added = Array(33).fill('');added[1] = 'D999';added[2] = 'Новый контрагент';
    added[15] = 'КАЗАНЬ';added[16] = 'Новый магазин';added[20] = '5500';
    added[25] = '89990000000';result.push(added);
  }
  return {work, accounting:result};
}

test('new accounting object appears in main work tab with protected fields and no duplicated code', () => {
  const {work,accounting} = fixture(true);
  const snapshot = buildSnapshot(work,accounting);
  const added = snapshot.rows.filter(row=>row.tabId === main.id && row.code === 'D999');
  assert.equal(added.length,1);
  assert.equal(added[0].key,'code:D999');
  assert.equal(added[0].accounting.monthlyCost,'5500');
  assert.equal(added[0].values[7],'Новый контрагент');
  assert.equal(added[0].values[15],'КАЗАНЬ');
  assert.equal(added[0].matchStatus,'linked');
  assert.equal(canEditColumn(main.id,7,added[0].values.length),false);
  assert.equal(canEditColumn(main.id,3,added[0].values.length),true);
});

test('when new accounting object later arrives in ДОП.РАБОТЫ, it merges by code without a duplicate', async t => {
  const {work,accounting} = fixture(true);
  const root = await mkdtemp(path.join(tmpdir(),'tech-source-add-'));
  const db = new DatabaseSync(path.join(root,'db.sqlite'));
  t.after(async () => {db.close();await rm(root,{recursive:true,force:true})});
  const store = createTechnicalStore(db);
  store.commitSnapshot(buildSnapshot(work,accounting));
  const fromAccounting = store.allRows(main.id,{q:'D999'}).items[0];
  assert.equal(fromAccounting.key,'code:D999');
  store.addNote(main.id,fromAccounting.key,'Позвонить после 15:00',
    {login:'self-reported',name:'Ирина',role:'editor'});
  const custom = store.addCustomColumn(main.id,'Технический статус');
  store.editCustomCell(main.id,fromAccounting.key,custom.id,'Назначен выезд',
    {login:'self-reported',name:'Ирина',role:'editor'});
  const workRow=Array(30).fill('');workRow[6]='D999';workRow[3]='Осмотр согласован';
  work[main.title].push(workRow);
  store.commitSnapshot(buildSnapshot(work,accounting));
  const matches=store.allRows(main.id,{q:'D999'}).items;
  assert.equal(matches.length,1);
  assert.equal(matches[0].key,'code:D999');
  assert.equal(store.recordDetail(main.id,fromAccounting.key).notes[0].body,'Позвонить после 15:00');
  assert.equal(store.recordDetail(main.id,fromAccounting.key).customValues[custom.id],'Назначен выезд');
  assert.equal(store.recordDetail(main.id,fromAccounting.key).values[3],'Осмотр согласован');
});

test('duplicate accounting codes are not guessed or converted to arbitrary rows', () => {
  const {work,accounting} = fixture(true);
  accounting.push([...accounting[2]]);
  const snapshot = buildSnapshot(work,accounting);
  assert.equal(snapshot.rows.filter(row=>row.code==='D999').length,0);
});

test('Apps Script row patch creates new accounting object without re-importing work sheets', async t => {
  const {work,accounting} = fixture(false);
  const root = await mkdtemp(path.join(tmpdir(),'tech-row-patch-'));
  const db = new DatabaseSync(path.join(root,'db.sqlite'));
  t.after(async () => {db.close();await rm(root,{recursive:true,force:true})});
  const store=createTechnicalStore(db);
  const sources={accounting};
  for(const tab of TECH_TABS) sources[`workbook:${tab.id}`]=work[tab.title];
  store.commitSnapshot(buildSnapshot(work,accounting),sources);
  const patch=createTechnicalPushReceiver(store, {TECH_PUSH_IMPORT_TOKEN:'x'.repeat(64)});
  const added=Array(33).fill('');
  added[1]='D111';added[2]='Объект из бухгалтерии';added[20]='8500';
  const result=patch.patch({key:'accounting',startRow:3,rows:[added]});
  assert.equal(result.ok,true);
  const items=store.allRows(main.id,{q:'D111'}).items;
  assert.equal(items.length,1);
  assert.equal(items[0].key,'code:D111');
  assert.equal(items[0].values[17],'8500');
  assert.equal(store.sourceSnapshot().accounting.length,3);
});

test('seven sheets and independent technical fields survive synthetic accounting rows', () => {
  const {work,accounting} = fixture(true);
  const snapshot = buildSnapshot(work,accounting);
  assert.equal(snapshot.sheets.length,7);
  assert.equal(snapshot.rows.filter(row=>row.tabId === main.id).length,2);
  assert.equal(snapshot.rows.filter(row=>row.tabId !== main.id).length,0);
});

test('100 rows per page keep horizontal scrolling, adjustable widths and required text wrapping', () => {
  const ui=readFileSync(new URL('../src/pages/Technical.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/pages/technical.css',import.meta.url),'utf8');
  assert.match(ui,/PAGE_SIZE = 100/);
  assert.match(ui,/limit:String\(PAGE_SIZE\)/);
  assert.match(ui,/tech-pagination/);
  assert.match(ui,/onScroll=\{onTableScroll\}/);
  assert.match(ui,/tech-horizontal-controls/);
  assert.match(ui,/tech-width-range/);
  assert.match(ui,/setWidthScale/);
  assert.match(ui,/autoFitAllColumns/);
  assert.match(ui,/onPointerDown=\{\(event\) => onResizeStart\(event, column\)\}/);
  assert.match(css,/white-space:pre-wrap/);
  assert.match(css,/overflow-y:auto/);
  assert.match(css,/tech-width-layout/);
  assert.doesNotMatch(ui,/const loadMore = useCallback/);
});
