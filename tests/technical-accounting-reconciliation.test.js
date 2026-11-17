import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {TECH_TABS, buildSnapshot} from '../server/modules/technical/model.js';
import {createTechnicalStore} from '../server/modules/technical/store.js';
import {createTechnicalPushReceiver} from '../server/modules/technical/push.js';

const main=TECH_TABS[0];
const actor={login:'self-reported',name:'Тестировщик'};
const uuid=(n)=>`aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12,'0')}`;
function acc(code,company,cost='2200') {
  const row=Array(26).fill('');
  row[1]=code;row[2]=company;row[15]='КАЗАНЬ';row[16]='Магазин';
  row[17]='Адрес';row[20]=cost;row[22]='1 раз в 3 месяца';
  row[23]='client@example.test';row[25]='89990000000';
  return row;
}
function workbook() {
  return Object.fromEntries(TECH_TABS.map(tab=>{
    const h=Array(30).fill('Заголовок');
    if(tab.id!==main.id) return [tab.title,[h]];
    const row=Array(30).fill('');row[6]='D240';row[3]='Старый техкомментарий';
    return [tab.title,[h,row]];
  }));
}
function createFixture() {
  const db=new DatabaseSync(':memory:');
  const store=createTechnicalStore(db);
  const sheet=workbook();
  const sources={accounting:[Array(26).fill('Заголовок'),acc('D240','ООО ФИССМАН')]};
  for(const tab of TECH_TABS) sources['workbook:'+tab.id]=sheet[tab.title];
  store.commitSnapshot(buildSnapshot(sheet,sources.accounting),sources);
  return {db,store,receiver:createTechnicalPushReceiver(store,{TECH_PUSH_IMPORT_TOKEN:'x'.repeat(64)})};
}
function reconcile(receiver,rows,n) {
  const runId=uuid(n);
  const chunks=[];
  for(let i=0;i<rows.length;i+=2)chunks.push(rows.slice(i,i+2));
  receiver.startAccounting({runId,expected:chunks.length});
  chunks.forEach((chunk,index)=>receiver.accountingChunk({runId,index,rows:chunk}));
  return receiver.commitAccounting({runId});
}

test('accounting reconciliation updates all mirrored fields, including clearing a cell',()=>{
  const {db,store,receiver}=createFixture();
  try {
    const name='code:D240';
    store.addNote(main.id,name,'Заметка инженера',actor);
    store.editCell(main.id,name,3,'Новая запись техотдела',actor);
    const updated=acc('D240','ООО ФИССМАН','4500');
    updated[6]='Комментарий Ирины';updated[23]='';updated[25]='';updated[17]='Новый адрес';
    const result=reconcile(receiver,[Array(26).fill('Заголовок'),updated],1);
    assert.equal(result.ok,true);
    const detail=store.recordDetail(main.id,name);
    assert.equal(detail.accounting.monthlyCost,'4500');
    assert.equal(detail.accounting.irina,'Комментарий Ирины');
    assert.equal(detail.accounting.email,'');
    assert.equal(detail.values[13],'');
    assert.equal(detail.values[12],'');
    assert.equal(detail.values[10],'Новый адрес');
    assert.equal(detail.values[3],'Новая запись техотдела');
    assert.equal(detail.notes[0].body,'Заметка инженера');
  } finally {db.close();}
});

test('new accounting companies with a code or only a name appear, and empty row disappears',()=>{
  const {db,store,receiver}=createFixture();
  try {
    const blank=acc('','Новая компания без кода','3500');
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН'),acc('D999','Новый объект'),blank],2);
    const records=store.allRows(main.id,{limit:100}).items;
    assert.ok(records.some(row=>row.key==='code:D999'&&row.accounting.company==='Новый объект'));
    assert.ok(records.some(row=>row.key==='accounting-row:4'&&row.accounting.company==='Новая компания без кода'&&row.matchStatus==='no-code'));
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН'),acc('D999','Новый объект'),Array(26).fill('')],3);
    assert.equal(store.recordDetail(main.id,'accounting-row:4'),null);
    assert.equal(store.allRows(main.id,{q:'Новая компания без кода'}).total,0);
  } finally {db.close();}
});

test('deleted accounting-only row disappears but employee notes are archived, not destroyed',()=>{
  const {db,store,receiver}=createFixture();
  try {
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН'),acc('D999','Удаляем')],4);
    store.addNote(main.id,'code:D999','Сохранить эту заметку',actor);
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН')],5);
    assert.equal(store.recordDetail(main.id,'code:D999'),null);
    assert.equal(store.allRows(main.id,{q:'D999'}).total,0);
    const count=db.prepare("SELECT COUNT(*) AS n FROM technical_notes WHERE record_key='code:D999'").get().n;
    assert.equal(count,1,'Source removal must not delete annotations');
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН'),acc('D999','Возврат')],6);
    assert.equal(store.recordDetail(main.id,'code:D999').notes[0].body,'Сохранить эту заметку');
  } finally {db.close();}
});

test('structural delete and reorder reconcile by code rather than row index',()=>{
  const {db,store,receiver}=createFixture();
  try {
    reconcile(receiver,[Array(26).fill('Header'),acc('D240','ООО ФИССМАН'),acc('D999','Второй')],7);
    reconcile(receiver,[Array(26).fill('Header'),acc('D999','Второй'),acc('D240','ООО ФИССМАН')],8);
    const row=store.recordDetail(main.id,'code:D999');
    assert.equal(row.accountingRow,2);
    assert.equal(store.recordDetail(main.id,'code:D240').accountingRow,3);
  }finally{db.close();}
});

test('incomplete accounting snapshot and malformed chunk never erase current data',()=>{
  const {db,store,receiver}=createFixture();
  try {
    const id=uuid(9);
    receiver.startAccounting({runId:id,expected:2});
    receiver.accountingChunk({runId:id,index:0,rows:[Array(26).fill('Header')]});
    assert.throws(()=>receiver.commitAccounting({runId:id}),error=>error.status===422);
    assert.equal(store.recordDetail(main.id,'code:D240').accounting.monthlyCost,'2200');
    assert.throws(()=>receiver.accountingChunk({runId:id,index:1,rows:[['invalid']]}),error=>error.status===400);
    receiver.accountingChunk({runId:id,index:1,rows:[acc('D240','ООО ФИССМАН','6000')]});
    receiver.commitAccounting({runId:id});
    assert.equal(store.recordDetail(main.id,'code:D240').accounting.monthlyCost,'6000');
  }finally{db.close();}
});

test('pending full import and accounting sync cannot overwrite one another',()=>{
  const {db,receiver}=createFixture();
  try {
    const id=uuid(10);
    receiver.startAccounting({runId:id,expected:1});
    const keys=Object.fromEntries(['accounting',...TECH_TABS.map(x=>'workbook:'+x.id)].map(x=>[x,1]));
    assert.throws(()=>receiver.start({runId:uuid(11),expected:keys}),err=>err.status===409);
    receiver.accountingChunk({runId:id,index:0,rows:[Array(26).fill('Header'),acc('D240','ООО ФИССМАН')]});
    receiver.commitAccounting({runId:id});
    receiver.start({runId:uuid(12),expected:keys});
    assert.throws(()=>receiver.startAccounting({runId:uuid(13),expected:1}),err=>err.status===409);
    assert.throws(()=>receiver.patch({key:'accounting',startRow:2,rows:[acc('D240','ООО ФИССМАН')]}),err=>err.status===409);
  }finally{db.close();}
});

test('Apps Script installs edit/change triggers and scheduled accounting reconciliation; server registers endpoints',()=>{
  const source=readFileSync(new URL('../apps-script/BoykovTechnicalPush.gs',import.meta.url),'utf8');
  const api=readFileSync(new URL('../server/modules/technical/index.js',import.meta.url),'utf8');
  assert.match(source,/everyMinutes\(5\)/);
  assert.match(source,/everyMinutes\(30\)/);
  assert.match(source,/newTrigger\('boykovTechOnEdit'\)/);
  assert.match(source,/newTrigger\('boykovTechOnChange'\)/);
  assert.match(source,/boykovTechSyncAccountingNow\(\)/);
  assert.match(api,/\['accounting\/commit', 'commitAccounting'\]/);
});

test('Apps Script onEdit sends changed accounting row and onChange sends atomic accounting reconciliation',async()=>{
  const {createContext,runInContext}=await import('node:vm');
  const source=readFileSync(new URL('../apps-script/BoykovTechnicalPush.gs',import.meta.url),'utf8');
  const props=new Map([
    ['BOYKOV_TECH_SERVER_URL','https://example.test'],
    ['BOYKOV_TECH_PUSH_TOKEN','t'.repeat(64)],
  ]);
  const actions=[];const registered=[];
  const accountingId='19ls1mrxtFD9gb18MZm8aTR_BEAA-LXulZfrUEZWL02E';
  const fakeSheet={
    getName:()=> 'П/О СЭР ТО', getLastRow:()=>2, getLastColumn:()=>26,
    getRange: (row,col,count,width)=>({getDisplayValues:()=>
      Array.from({length:count},(_,i)=>i+row===1?Array(26).fill('Header'):acc('D240','Фирма'))}),
  };
  const scriptProperties={
    getProperty:(key)=>props.get(key)||null,
    setProperty:(key,value)=>props.set(key,value),
    deleteProperty:(key)=>props.delete(key),
  };
  const context=createContext({
    console:{log:()=>{},error:()=>{}},
    Date,JSON,Math,String,Array,Number,Error,
    PropertiesService:{getScriptProperties:()=>scriptProperties},
    LockService:{getScriptLock:()=>({tryLock:()=>true,waitLock:()=>{},releaseLock:()=>{}})},
    SpreadsheetApp:{openById:(id)=>id===accountingId?{getSheetByName:()=>fakeSheet,getSheets:()=>[fakeSheet]}:{getSheets:()=>[]}},
    Utilities:{getUuid:()=>uuid(14),sleep:()=>{}},
    UrlFetchApp:{fetch:(url,opts)=>{actions.push({url,payload:JSON.parse(opts.payload)});return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,counts:{total:1,linked:1}})};}},
    ScriptApp:{
      getProjectTriggers:()=>[],
      newTrigger:(name)=>({forSpreadsheet:()=>({onEdit:()=>({create:()=>registered.push(name)}),onChange:()=>({create:()=>registered.push(name)})}),timeBased:()=>({everyMinutes:(n)=>({create:()=>registered.push(name+':'+n)})})}),
    },
  });
  runInContext(source,context);
  runInContext('setupBoykovTechPush()',context);
  assert.equal(registered.filter(x=>x==='boykovTechOnEdit').length,2);
  assert.equal(registered.filter(x=>x==='boykovTechOnChange').length,2);
  assert.ok(registered.includes('boykovTechAccountingReconcile:5'));
  runInContext(`boykovTechOnEdit({source:{getId:()=> '${accountingId}'},range:{getSheet:()=>SpreadsheetApp.openById('${accountingId}').getSheetByName('П/О СЭР ТО'),getColumn:()=>3,getNumColumns:()=>1,getRow:()=>2,getNumRows:()=>1,getA1Notation:()=> 'C2'}})`,context);
  assert.ok(actions.some(a=>a.url.endsWith('/hooks/technical/import/patch')));
  // Structural deletion is never sent as a one-row patch.
  runInContext(`boykovTechOnChange({source:{getId:()=> '${accountingId}'},changeType:'REMOVE_ROW'})`,context);
  assert.ok(actions.some(a=>a.url.endsWith('/hooks/technical/import/accounting/start')));
  assert.ok(actions.some(a=>a.url.endsWith('/hooks/technical/import/accounting/chunk')));
  assert.ok(actions.some(a=>a.url.endsWith('/hooks/technical/import/accounting/commit')));
});

test('new accounting reconciliation routes reject missing secrets and accept signed data',async()=>{
  const {createTechnicalModule}=await import('../server/modules/technical/index.js');
  const db=new DatabaseSync(':memory:');
  const service=createTechnicalModule(db,{technicalEnv:{TECH_PUSH_IMPORT_TOKEN:'z'.repeat(64)},disableTechnicalStartupSync:true});
  try{
    const routes=new Map();
    service.registerPushHooks({post:(path,handler)=>routes.set(path,handler)});
    for(const action of ['start','chunk','commit']) {
      assert.ok(routes.has('/hooks/technical/import/accounting/'+action));
    }
    const replies=[];
    const response=()=>({code:200,status(n){this.code=n;return this},json(data){replies.push({status:this.code,data});return this}});
    let res=response();
    routes.get('/hooks/technical/import/accounting/start')({headers:{authorization:'Bearer invalid','content-type':'application/json'},body:{runId:uuid(20),expected:1}},res);
    assert.equal(res.code,403);
    res=response();
    routes.get('/hooks/technical/import/accounting/start')({headers:{authorization:'Bearer '+'z'.repeat(64),'content-type':'application/json'},body:{runId:uuid(20),expected:1}},res);
    assert.equal(res.code,200);
  }finally{service.stop();db.close();}
});
