import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {TECH_TABS,buildSnapshot} from '../server/modules/technical/model.js';
import {createTechnicalStore} from '../server/modules/technical/store.js';
const sheet=TECH_TABS[0];
const work=Object.fromEntries(TECH_TABS.map(tab=>[tab.title,[Array(30).fill('Заголовок'),... (tab.id===sheet.id ? [Object.assign(Array(30).fill(''),{6:'D240',7:'Компания'})] : []) ]]));
const accounts=[Array(33).fill('Заголовок'),Object.assign(Array(33).fill(''),{1:'D240',2:'Компания'})];

test('cell color and whole column color persist independently across reimport',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'tech-color-test-'));
 const db=new DatabaseSync(path.join(dir,'test.db'));
 t.after(async()=>{db.close(); await rm(dir,{force:true,recursive:true})});
 const store=createTechnicalStore(db);
 store.commitSnapshot(buildSnapshot(work,accounts));
 const row=store.allRows(sheet.id).items[0];
 assert.equal(store.setColumnColor(sheet.id,'sheet:0','rose').color,'rose');
 assert.equal(store.setCellColor(sheet.id,row.key,'sheet:0','green').color,'green');
 assert.equal(store.allRows(sheet.id).items[0].cellColors['sheet:0'],'green');
 assert.equal(store.columnColors()[sheet.id+':sheet:0'],'rose');
 store.commitSnapshot(buildSnapshot(work,accounts));
 const again=createTechnicalStore(db);
 assert.equal(again.allRows(sheet.id).items[0].cellColors['sheet:0'],'green');
 assert.equal(again.columnColors()[sheet.id+':sheet:0'],'rose');
 again.setCellColor(sheet.id,row.key,'sheet:0','none');
 assert.equal(again.allRows(sheet.id).items[0].cellColors['sheet:0'],undefined);
 assert.equal(again.columnColors()[sheet.id+':sheet:0'],'rose');
});

test('cell coloring validates row, field, and allowed palette',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'tech-color-test-'));
 const db=new DatabaseSync(path.join(dir,'test.db'));
 t.after(async()=>{db.close(); await rm(dir,{force:true,recursive:true})});
 const store=createTechnicalStore(db);
 store.commitSnapshot(buildSnapshot(work,accounts));
 const row=store.allRows(sheet.id).items[0];
 assert.throws(()=>store.setCellColor(sheet.id,row.key,'sheet:0','rgb(3,4,5)'),/цвет/);
 assert.throws(()=>store.setCellColor(sheet.id,row.key,'sheet:900','amber'),/не найден/);
 assert.throws(()=>store.setCellColor(sheet.id,'missing','sheet:0','blue'),/не найдена/);
});
