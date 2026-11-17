import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildSnapshot, TECH_TABS } from '../server/modules/technical/model.js';
import { createTechnicalStore } from '../server/modules/technical/store.js';

const main = TECH_TABS[0].id;
const person = { login: 'self-reported', name: 'Тестовый сотрудник' };
function setup() {
  const db = new DatabaseSync(':memory:');
  const store = createTechnicalStore(db);
  const accounting = Array(26).fill('');
  accounting[1] = 'D240'; accounting[2] = 'ООО ФИССМАН'; accounting[20] = '2200';
  const workbook = Object.fromEntries(TECH_TABS.map((tab) => {
    const row = Array(30).fill('');
    row[0] = 'техническое поле';
    if (tab.id === main) { row[6] = 'D240'; row[3] = 'Первое'; row[17] = '1700'; }
    return [tab.title, [Array(30).fill('Заголовок'),row]];
  }));
  store.commitSnapshot(buildSnapshot(workbook,[Array(26).fill('Заголовок'),accounting]));
  return { db,store };
}

test('cell undo/redo does not overwrite a colleague and preserves accounting locks', () => {
  const {db,store}=setup();
  try {
    store.editCell(main,'code:D240',3,'Второе',person,'Первое');
    assert.equal(store.readRow(main,'code:D240').values[3],'Второе');
    assert.throws(() => store.editCell(main,'code:D240',3,'Первое',person,'Старое'),e=>e.status===409);
    assert.equal(store.readRow(main,'code:D240').values[3],'Второе');
    store.editCell(main,'code:D240',3,'Первое',person,'Второе');
    store.editCell(main,'code:D240',3,'Второе',person,'Первое');
    assert.equal(store.readRow(main,'code:D240').values[3],'Второе');
    assert.throws(() => store.editCell(main,'code:D240',17,'1',person,'2200'), e=>e.status===403);
    assert.equal(store.readRow(main,'code:D240').values[17],'2200');
  } finally {db.close();}
});
test('shared cell and column colors protect colleagues changes', () => {
  const {db,store}=setup();
  try {
    store.setColumnColor(main,'sheet:3','rose','none');
    assert.throws(() => store.setColumnColor(main,'sheet:3','blue','none'),e=>e.status===409);
    store.setColumnColor(main,'sheet:3','none','rose');
    store.setCellColor(main,'code:D240','sheet:3','green','none');
    assert.throws(() => store.setCellColor(main,'code:D240','sheet:3','rose','none'),e=>e.status===409);
    store.setCellColor(main,'code:D240','sheet:3','none','green');
    assert.equal(store.readRow(main,'code:D240').cellColors['sheet:3'],undefined);
  } finally {db.close();}
});
test('undo/redo custom values and creation/archiving preserves data', () => {
  const {db,store}=setup();
  try {
    const col=store.addCustomColumn(main,'Новый статус');
    store.editCustomCell(main,'code:D240',col.id,'Готово',person,'');
    assert.throws(()=>store.editCustomCell(main,'code:D240',col.id,'Черновик',person,''),e=>e.status===409);
    store.editCustomCell(main,'code:D240',col.id,'',person,'Готово');
    store.editCustomCell(main,'code:D240',col.id,'Готово',person,'');
    store.archiveCustomColumn(main,col.id,false);
    assert.throws(()=>store.archiveCustomColumn(main,col.id,false),e=>e.status===409);
    store.restoreCustomColumn(main,col.id,true);
    assert.equal(store.readRow(main,'code:D240').customValues[col.id],'Готово');
    assert.throws(()=>store.restoreCustomColumn(main,col.id,true),e=>e.status===409);
    store.archiveCustomColumn(main,col.id,false);
    store.restoreCustomColumn(main,col.id,true);
    assert.equal(store.readRow(main,'code:D240').customValues[col.id],'Готово');
  } finally {db.close();}
});
test('UI has visible Undo/Redo buttons and shortcuts but does not intercept typed text', () => {
  const ui=readFileSync(new URL('../src/pages/Technical.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/pages/technical.css',import.meta.url),'utf8');
  assert.match(ui,/undoStack/);
  assert.match(ui,/redoStack/);
  assert.match(ui,/Ctrl\+Z/);
  assert.match(ui,/Ctrl\+Y/);
  assert.match(ui,/Отменить последнее изменение/);
  assert.match(ui,/Повторить отменённое изменение/);
  assert.match(ui,/closest\('input,textarea,select/);
  assert.match(css,/\.tech-undo-redo/);
});
