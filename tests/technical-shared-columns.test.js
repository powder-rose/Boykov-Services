import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createTechnicalStore } from '../server/modules/technical/store.js';
import { buildSnapshot, TECH_TABS } from '../server/modules/technical/model.js';

const person = {login:'self-reported',name:'Мария',role:'editor'};
const accountingHeader = Array.from({length:33},(_,i)=>`Бух ${i}`);
const accountingRow = Array.from({length:33},()=> '');
accountingRow[1] = 'D240';accountingRow[2]='Компания';accountingRow[6]='Комментарий Ирины';
accountingRow[20]='2200';
const workbook = Object.fromEntries(TECH_TABS.map((tab,index)=>{
 const row = Array(index === 1 ? 32 : 30).fill('');
 row[0] = index ? `Название ${index}` : 'Менеджер';
 if(index===0) {row[6]='D240';row[7]='Компания';row[17]='1700';}
 const header = Array.from({length:row.length},(_,n)=>`Поле ${n+1}`);
 return [tab.title,[header,row]];
}));

async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'boykov-custom-fields-'));
 const filename=path.join(root,'tech.sqlite');
 const db=new DatabaseSync(filename);db.exec('PRAGMA journal_mode=WAL;');
 const store=createTechnicalStore(db);
 store.commitSnapshot(buildSnapshot(workbook,[accountingHeader,accountingRow]));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})});
 return {store,db};
}

const first=TECH_TABS[0].id;
const getFirstRow=(store,tab=first)=>store.allRows(tab).items[0];

test('original seven sheets remain unchanged until a new field is explicitly added',async(t)=>{
 const {store}=await fixture(t);
 const tabs=store.snapshotSheets();
 assert.equal(tabs.length,7);
 assert.deepEqual(tabs.map(tab=>tab.customColumns.length),Array(7).fill(0));
 assert.equal(tabs[0].headers.length,30);
 assert.equal(tabs[1].headers.length,32);
 assert.equal(getFirstRow(store).values[17],'2200');
});

test('new field and user input persist across synchronization and retain author history',async(t)=>{
 const {store}=await fixture(t);
 const main=store.snapshotSheets()[0];
 const row=getFirstRow(store);
 const added=store.addCustomColumn(first,'Следующий выезд');
 assert.equal(added.title,'Следующий выезд');
 assert.equal(store.snapshotSheets()[0].headers.length,30);
 assert.equal(store.snapshotSheets()[0].customColumns.length,1);
 const changed=store.editCustomCell(first,row.key,added.id,'22.12.2026',person);
 assert.equal(changed.authorName,'Мария');
 assert.equal(store.recordDetail(first,row.key).customValues[added.id],'22.12.2026');
 assert.equal(store.recordDetail(first,row.key).changes[0].columnTitle,'Следующий выезд');
 assert.ok(store.allRows(first,{q:'22.12.2026'}).items.some(r=>r.key===row.key));
 const w=structuredClone(workbook);
 w[main.title][1][0]='Новый менеджер';
 store.commitSnapshot(buildSnapshot(w,[accountingHeader,accountingRow]));
 assert.equal(store.recordDetail(first,row.key).customValues[added.id],'22.12.2026');
 assert.equal(store.snapshotSheets()[0].customColumns[0].title,'Следующий выезд');
 assert.equal(store.recordDetail(first,row.key).values[0],'Новый менеджер');
});

test('shared color survives a fresh store instance and another browser',async(t)=>{
 const {store,db}=await fixture(t);
 const field=store.addCustomColumn(first,'Комментарий мастера');
 assert.deepEqual(store.setColumnColor(first,'custom:'+field.id,'green'),{columnKey:'custom:'+field.id,color:'green'});
 store.setColumnColor(first,'sheet:0','amber');
 store.setColumnColor(first,'accounting:irina','blue');
 const secondStore=createTechnicalStore(db);
 assert.equal(secondStore.columnColors()[first+':custom:'+field.id],'green');
 assert.equal(secondStore.columnColors()[first+':sheet:0'],'amber');
 assert.equal(secondStore.columnColors()[first+':accounting:irina'],'blue');
 secondStore.setColumnColor(first,'sheet:0','none');
 assert.equal(store.columnColors()[first+':sheet:0'],undefined);
});

test('invalid colors/columns are rejected; accounting fields remain protected',async(t)=>{
 const {store}=await fixture(t);
 const row=getFirstRow(store);
 assert.throws(()=>store.setColumnColor(first,'sheet:0','rgb(0,0,0)'),/цвет/);
 assert.throws(()=>store.setColumnColor(first,'sheet:500','rose'),/не найден/);
 assert.throws(()=>store.setColumnColor(first,'custom:deadbeefdeadbeefdeadbeef','green'),/не найден/);
 assert.throws(()=>store.editCell(first,row.key,6,'delete-code',person),/нельзя/);
 assert.throws(()=>store.editCustomCell(first,row.key,'deadbeefdeadbeefdeadbeef','bad',person),/не найдено/);
 assert.equal(store.recordDetail(first,row.key).values[6],'D240');
});

test('every tab may add named fields, but no more than 50 visible work columns',async(t)=>{
 const {store}=await fixture(t);
 assert.throws(()=>store.addCustomColumn(first,''),/Название/);
 assert.throws(()=>store.addCustomColumn(first,'Поле 1'),/уже есть/);
 for(let i=1;i<=20;i++) store.addCustomColumn(first,`Колонка ${i}`);
 assert.equal(store.snapshotSheets()[0].headers.length+store.snapshotSheets()[0].customColumns.length,50);
 assert.throws(()=>store.addCustomColumn(first,'Колонка 21'),/предел/);
 const t2=store.snapshotSheets()[1];
 assert.equal(t2.customColumns.length,0);
 const one=store.addCustomColumn(t2.id,'Отдельная отметка');
 assert.equal(store.snapshotSheets()[1].customColumns[0].id,one.id);
});

test('notes, original values and new fields coexist without writing to Google',async(t)=>{
 const {store}=await fixture(t);
 const row=getFirstRow(store);
 const col=store.addCustomColumn(first,'Отметка');
 store.addNote(first,row.key,'Первый осмотр',person);
 store.editCustomCell(first,row.key,col.id,'Готово',person);
 const item=store.recordDetail(first,row.key);
 assert.equal(item.accounting.monthlyCost,'2200');
 assert.equal(item.notes[0].body,'Первый осмотр');
 assert.equal(item.customValues[col.id],'Готово');
 assert.equal(item.values[17],'2200');
});
