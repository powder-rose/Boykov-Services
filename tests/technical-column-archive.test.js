import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { TECH_TABS, buildSnapshot } from '../server/modules/technical/model.js';
import { createTechnicalStore } from '../server/modules/technical/store.js';

const MAIN = TECH_TABS[0].id;
const ACCOUNTS = [Array(33).fill('Бухгалтерия'), Object.assign(Array(33).fill(''),{
  1:'D240',2:'ООО ФИССМАН',6:'Комментарий Ирины',20:'2200',
})];
const WORKBOOK = Object.fromEntries(TECH_TABS.map(tab => {
  const row = Array(30).fill('');
  row[0]='Менеджер';
  if(tab.id===MAIN){row[6]='D240';row[7]='ООО ФИССМАН';}
  return [tab.title,[Array.from({length:30},(_,i)=>`Источник ${i+1}`),row]];
}));
const staff={login:'self-reported',name:'Технический отдел',role:'editor'};
const fixture = async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'boykov-archived-fields-'));
  const db=new DatabaseSync(path.join(dir,'tech.sqlite'));
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true})});
  const store=createTechnicalStore(db);
  store.commitSnapshot(buildSnapshot(WORKBOOK,ACCOUNTS));
  return {db,store};
};

test('archiving only user-added fields hides the column without destroying data, audit or shared colors',async t=>{
  const {store,db}=await fixture(t);
  const row=store.allRows(MAIN).items[0];
  const column=store.addCustomColumn(MAIN,'Дата следующего выезда');
  store.editCustomCell(MAIN,row.key,column.id,'15.12.2026',staff);
  store.setColumnColor(MAIN,`custom:${column.id}`,'rose');
  store.setCellColor(MAIN,row.key,`custom:${column.id}`,'green');
  const hidden=store.archiveCustomColumn(MAIN,column.id);
  assert.equal(hidden.archived,true);
  assert.equal(store.snapshotSheets()[0].customColumns.length,0);
  assert.equal(store.snapshotSheets()[0].archivedCustomColumns[0].title,column.title);
  assert.equal(store.recordDetail(MAIN,row.key).customValues[column.id],undefined);
  assert.equal(store.allRows(MAIN,{q:'15.12.2026'}).total,0);
  assert.throws(()=>store.editCustomCell(MAIN,row.key,column.id,'сбой',staff),/не найдено/);
  assert.throws(()=>store.setColumnColor(MAIN,`custom:${column.id}`,'amber'),/не найден/);
  assert.equal(db.prepare('SELECT value FROM technical_custom_values WHERE column_id=?').get(column.id).value,'15.12.2026');
  assert.ok(db.prepare('SELECT count(*) AS n FROM technical_custom_audit WHERE column_id=?').get(column.id).n>0);
  store.commitSnapshot(buildSnapshot(WORKBOOK,ACCOUNTS));
  const afterRestart=createTechnicalStore(db);
  assert.equal(afterRestart.snapshotSheets()[0].customColumns.length,0);
  assert.equal(afterRestart.snapshotSheets()[0].archivedCustomColumns.length,1);
  afterRestart.restoreCustomColumn(MAIN,column.id);
  assert.equal(afterRestart.snapshotSheets()[0].customColumns[0].id,column.id);
  assert.equal(afterRestart.recordDetail(MAIN,row.key).customValues[column.id],'15.12.2026');
  assert.equal(afterRestart.columnColors()[`${MAIN}:custom:${column.id}`],'rose');
  assert.equal(afterRestart.recordDetail(MAIN,row.key).cellColors[`custom:${column.id}`],'green');
});

test('never permits deletion of source or accounting columns; archived title can be reused without sort-order collisions',async t=>{
  const {store}=await fixture(t);
  assert.throws(()=>store.archiveCustomColumn(MAIN,'sheet:0'),/только/);
  assert.throws(()=>store.archiveCustomColumn(MAIN,'accounting:irina'),/только/);
  assert.throws(()=>store.archiveCustomColumn(MAIN,'aaaaaaaaaaaaaaaaaaaaaaaa'),/Исходные/);
  const original=store.addCustomColumn(MAIN,'Проверка');
  store.archiveCustomColumn(MAIN,original.id);
  const second=store.addCustomColumn(MAIN,'Проверка');
  assert.notEqual(original.id,second.id);
  assert.equal(store.snapshotSheets()[0].customColumns[0].id,second.id);
  assert.throws(()=>store.restoreCustomColumn(MAIN,original.id),/совпадающий/);
  store.archiveCustomColumn(MAIN,second.id);
  store.restoreCustomColumn(MAIN,original.id);
  assert.equal(store.snapshotSheets()[0].customColumns.length,1);
  assert.equal(store.snapshotSheets()[0].archivedCustomColumns.length,1);
});

test('existing Google and accounting columns remain untouched and all seven work tabs survive',async t=>{
  const {store}=await fixture(t);
  const col=store.addCustomColumn(MAIN,'Тестовое поле');
  store.archiveCustomColumn(MAIN,col.id);
  assert.equal(store.snapshotSheets().length,7);
  assert.equal(store.snapshotSheets()[0].headers.length,30);
  assert.equal(store.allRows(MAIN).items[0].values[6],'D240');
  assert.equal(store.allRows(MAIN).items[0].accounting.monthlyCost,'2200');
});

test('UX has discoverable add actions, delete and restore controls, brand-soft alternation, and no change to starting width',()=>{
  const c=readFileSync(new URL('../src/pages/Technical.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/pages/technical.css',import.meta.url),'utf8');
  assert.match(c,/className="tech-add-side"/);
  assert.match(c,/className="tech-add-bottom"/);
  assert.match(c,/setPendingRevealColumnId\(`custom:\$\{created.id\}`\)/);
  assert.match(c,/className="tech-header-remove"/);
  assert.match(c,/archiveField\(\)/);
  assert.match(c,/restoreField\(field\)/);
  assert.match(css,/#f7faf7/);
  assert.match(css,/#fdf8fa/);
  assert.match(c,/const \[widthScales, setWidthScales\] = useState<Record<string, number>>\(readWidthScales\)/);
  assert.match(c,/const widthScale = widthScales\[tab\] \?\? 1/);
});
