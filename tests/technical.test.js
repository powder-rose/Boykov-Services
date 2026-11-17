import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildSnapshot, TECH_TABS, effectiveValues, canEditColumn } from '../server/modules/technical/model.js';
import { createTechnicalStore } from '../server/modules/technical/store.js';

const targetTab = TECH_TABS[0];
const accountant = (code, cost='2200') => {
  const cells = Array(33).fill('');
  cells[1]=code; cells[2]='ООО ФИССМАН'; cells[6]='Цена обновлена бухгалтерией';
  cells[15]='АНАПА'; cells[16]='магазин FISSMAN'; cells[17]='г. Анапа';
  cells[20]=cost; cells[22]='1 раз в 3 месяца';cells[23]='client@example.com';cells[25]='89990001122';
  return cells;
};
const target = (code='D240') => {
  const row = Array(30).fill('');
  row[3]='Существующая заметка';row[6]=code;row[7]='Старое название';row[17]='1700';
  row[18]='1'; row[21]='4';
  return row;
};
const workbook = () => Object.fromEntries(TECH_TABS.map(t=>[t.title,[Array(30).fill('Наименование'),targetTab.id===t.id?target():['другие','данные']]]));
const person = {login:'victoria',name:'Виктория',role:'editor'};

test('imports seven target tabs and only the required accounting tab, matching by code', () => {
  const snapshot = buildSnapshot(workbook(),[['Код объекта'], accountant('D240')]);
  assert.equal(snapshot.sheets.length,7);
  assert.equal(snapshot.rows.length,7);
  const row=snapshot.rows.find(r=>r.tabId===targetTab.id);
  assert.equal(row.matchStatus,'linked');
  assert.equal(row.accounting.monthlyCost,'2200');
  assert.equal(row.accounting.irina,'Цена обновлена бухгалтерией');
  assert.equal(effectiveValues(row,[])[17],'2200');
  assert.equal(effectiveValues(row,[])[3],'Существующая заметка');
  assert.equal(effectiveValues(row,[])[21],'4');
});
test('an absent or repeated accounting code never silently joins the wrong contract', () => {
  const ambiguous=buildSnapshot(workbook(),[['Код объекта'],accountant('D240'),accountant('D240','2500')]);
  assert.equal(ambiguous.rows[0].matchStatus,'ambiguous');
  assert.equal(ambiguous.rows[0].accounting,null);
  const missing=buildSnapshot(workbook(),[['Код объекта'],accountant('D404')]);
  assert.equal(missing.rows[0].matchStatus,'not-found');
});
test('tech-side notes and edits survive full resync, accounting cells stay locked', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const store=createTechnicalStore(db);
    store.commitSnapshot(buildSnapshot(workbook(),[['Код объекта'],accountant('D240')]));
    const row=store.allRows(targetTab.id).items[0];
    assert.equal(row.accounting.monthlyCost,'2200');
    assert.equal(canEditColumn(targetTab.id,17,30),false);
    assert.equal(canEditColumn(targetTab.id,3,30),true);
    assert.throws(()=>store.editCell(targetTab.id,row.key,17,'150',person),e=>e.status===403);
    store.editCell(targetTab.id,row.key,3,'Новая тех. информация',person);
    store.addNote(targetTab.id,row.key,'Выезд согласован',person);
    store.commitSnapshot(buildSnapshot(workbook(),[['Код объекта'],accountant('D240','3300')]));
    const detail=store.recordDetail(targetTab.id,row.key);
    assert.equal(detail.accounting.monthlyCost,'3300');
    assert.equal(detail.values[17],'3300');
    assert.equal(detail.values[3],'Новая тех. информация');
    assert.equal(detail.notes[0].authorName,'Виктория');
    assert.equal(detail.changes[0].authorName,'Виктория');
    assert.equal(detail.rowNumber,2);
  } finally { db.close(); }
});
test('extra technical tabs are preserved without forcing accounting matches',()=>{
  const x=buildSnapshot(workbook(),[['Код объекта'],accountant('D240')]);
  const other=x.rows.find(r=>r.tabId===TECH_TABS[1].id);
  assert.equal(other.matchStatus,'separate-tab');
  assert.equal(other.accounting,null);
});

test('sync service writes atomically and keeps last good data when the source fails', async () => {
  const { createTechnicalModule } = await import('../server/modules/technical/index.js');
  const db = new DatabaseSync(':memory:');
  let healthy = true;
  const controller = createTechnicalModule(db, {
    technicalReader: async () => {
      if (!healthy) throw new Error('Google Sheets temporarily unavailable');
      return { workbook: workbook(), accounting: [['Код объекта'], accountant('D240')] };
    },
    disableTechnicalTimer: true,
    disableTechnicalStartupSync: true,
  });
  try {
    const result = await controller.syncNow();
    assert.equal(result.total,7);
    const row = controller.store.allRows(targetTab.id).items[0];
    healthy = false;
    await assert.rejects(controller.syncNow(), /Google Sheets temporarily unavailable/);
    assert.equal(controller.store.allRows(targetTab.id).items[0].key,row.key);
    assert.match(controller.store.meta('lastError'),/Google Sheets/);
  } finally { controller.stop();db.close(); }
});

test('Google reader uses read-only OAuth and explicitly requests seven working tabs plus one accounting tab', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { readTechnicalGoogleSheets } = await import('../server/modules/technical/google.js');
  const { privateKey } = generateKeyPairSync('rsa',{modulusLength:2048});
  const env={
    GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',client_email:'test-readonly@example.iam.gserviceaccount.com',
      private_key:privateKey.export({type:'pkcs8',format:'pem'}),token_uri:'https://oauth2.googleapis.com/token'}),
    TECH_ACCOUNTING_SHEET_ID:'accounting-fixture', TECH_WORKBOOK_SHEET_ID:'technical-fixture'
  };
  const requests=[];
  const mockFetch=async(url, options) => {
    requests.push({url:String(url),options});
    if(String(url).includes('/token')) return Response.json({access_token:'test-token',expires_in:3600});
    if(String(url).includes('technical-fixture')) return Response.json({valueRanges:TECH_TABS.map(t=>({values:[['header'],[t.title]]}))});
    return Response.json({valueRanges:[{values:[['header'],accountant('D240')]}]});
  };
  const result=await readTechnicalGoogleSheets({env,fetchImpl:mockFetch});
  assert.equal(Object.keys(result.workbook).length,7);
  assert.equal(result.accounting.length,2);
  const queries=requests.filter(r=>r.url.includes('values:batchGet'));
  assert.equal(queries.length,2);
  assert.ok(new URL(queries[0].url).searchParams.getAll('ranges').some(r=>r.includes('СЭР ТО МСК РЕГИОНЫ')));
  assert.match(queries[1].url,/accounting-fixture/);
  assert.ok(queries[0].options.headers.Authorization.startsWith('Bearer '));
});

// Новый вариант подключения: Apps Script отправляет снимки в Boykov-services.
// Не требует Google Cloud, OAuth или JSON-ключа сервисного аккаунта.
test('Apps Script importer requires all eight sheets and commits atomically', async () => {
  const { createTechnicalPushReceiver, technicalSourceKey } = await import('../server/modules/technical/push.js');
  const db = new DatabaseSync(':memory:');
  try {
    const store = createTechnicalStore(db);
    const receiver = createTechnicalPushReceiver(store, {TECH_PUSH_IMPORT_TOKEN:'a'.repeat(64)});
    const id = 'caaa8d0e-61c4-47cc-8ac5-2f919bbd550f';
    const inputs = {
      accounting: [['header'], accountant('D240')],
      ...Object.fromEntries(TECH_TABS.map(t => [technicalSourceKey(t.id), workbook()[t.title]]))
    };
    const expected = Object.fromEntries(Object.keys(inputs).map(key=>[key,1]));
    receiver.start({runId:id,expected});
    receiver.chunk({runId:id,key:'accounting',index:0,rows:inputs.accounting});
    assert.throws(()=>receiver.commit({runId:id}),error=>error.status===422);
    assert.equal(store.allRows(targetTab.id).total,0,'Partial import must not replace data');
    for(const [key,rows] of Object.entries(inputs)) {
      if(key!=='accounting') receiver.chunk({runId:id,key,index:0,rows});
    }
    const result = receiver.commit({runId:id});
    assert.equal(result.counts.total,7);
    assert.equal(store.allRows(targetTab.id).items[0].accounting.monthlyCost,'2200');
    assert.ok(store.sourceSnapshot().accounting.length>=2);
  } finally { db.close(); }
});

test('Apps Script row patch updates accounting instantly without touching employee work', async () => {
  const { createTechnicalPushReceiver, technicalSourceKey } = await import('../server/modules/technical/push.js');
  const db = new DatabaseSync(':memory:');
  try {
    const store=createTechnicalStore(db);
    const receiver=createTechnicalPushReceiver(store,{});
    const runId='7a28bd6b-7831-4c57-b70c-074c66dfd352';
    const inputs={accounting:[['head'], accountant('D240')],
      ...Object.fromEntries(TECH_TABS.map(t=>[technicalSourceKey(t.id),workbook()[t.title]]))};
    receiver.start({runId,expected:Object.fromEntries(Object.keys(inputs).map(k=>[k,1]))});
    for(const [key,rows] of Object.entries(inputs))receiver.chunk({runId,key,index:0,rows});
    receiver.commit({runId});
    const key=store.allRows(targetTab.id).items[0].key;
    store.editCell(targetTab.id,key,3,'Задача инженера',person);
    store.addNote(targetTab.id,key,'Нужен выезд',person);
    receiver.patch({key:'accounting',startRow:2,rows:[accountant('D240','4500')]});
    const detail=store.recordDetail(targetTab.id,key);
    assert.equal(detail.accounting.monthlyCost,'4500');
    assert.equal(detail.values[3],'Задача инженера');
    assert.equal(detail.notes.length,1);
    assert.equal(detail.notes[0].authorName,'Виктория');
    assert.throws(()=>receiver.patch({key:'accounting',startRow:99999,rows:[[]]}),e=>e.status===400);
  } finally { db.close(); }
});

test('Apps Script import token must match in constant-time length-safe comparison', async () => {
  const {samePushToken,isPushConfigured} = await import('../server/modules/technical/push.js');
  const secret='f'.repeat(64);
  assert.equal(isPushConfigured({TECH_PUSH_IMPORT_TOKEN:secret}),true);
  assert.equal(isPushConfigured({}),false);
  assert.equal(samePushToken(secret,secret),true);
  assert.equal(samePushToken('bad',secret),false);
});

test('restarting incomplete Apps Script import cannot erase last committed data', async () => {
  const {createTechnicalPushReceiver,technicalSourceKey}=await import('../server/modules/technical/push.js');
  const db=new DatabaseSync(':memory:');
  try {
    const store=createTechnicalStore(db);
    const receiver=createTechnicalPushReceiver(store,{});
    const inputs={accounting:[['header'],accountant('D240')],
      ...Object.fromEntries(TECH_TABS.map(t=>[technicalSourceKey(t.id),workbook()[t.title]]))};
    const expected=Object.fromEntries(Object.keys(inputs).map(k=>[k,1]));
    const first='2fdd8374-9793-4a0d-985d-17e304db6e38';
    receiver.start({runId:first,expected});
    for(const [key,rows] of Object.entries(inputs)) receiver.chunk({runId:first,key,index:0,rows});
    receiver.commit({runId:first});
    const next='8ccddfbb-f0b3-4624-ae50-d2b6b8b77c40';
    receiver.start({runId:next,expected});
    receiver.chunk({runId:next,key:'accounting',index:0,rows:[['head'],accountant('D240','9999')]});
    assert.equal(store.allRows(targetTab.id).items[0].accounting.monthlyCost,'2200');
    const third='d02b0225-0a05-4f43-9fb2-9b4f9b564137';
    receiver.start({runId:third,expected});
    assert.throws(()=>receiver.commit({runId:next}),e=>e.status===409);
    assert.equal(store.allRows(targetTab.id).items[0].accounting.monthlyCost,'2200');
  } finally {db.close();}
});

test('push endpoints reject unauthenticated requests and do not need Google credentials', async () => {
  const {createTechnicalModule}=await import('../server/modules/technical/index.js');
  const db=new DatabaseSync(':memory:');
  const token='1'.repeat(64);
  const module=createTechnicalModule(db,{technicalEnv:{TECH_PUSH_IMPORT_TOKEN:token},disableTechnicalStartupSync:true});
  const routes=new Map();
  module.registerPushHooks({post:(path,handler)=>routes.set(path,handler)});
  try {
    const handler=routes.get('/hooks/technical/import/start');
    assert.equal(typeof handler,'function');
    const respond=(authorization,body={})=>{
      const status={code:200};
      const res={status(code){status.code=code;return this;},json(v){return {status:status.code,body:v};}};
      return handler({headers:{authorization,'content-type':'application/json'},body},res);
    };
    assert.equal(respond('',{}).status,403);
    assert.equal(respond('Bearer wrong',{}).status,403);
    const expected={accounting:1,...Object.fromEntries(TECH_TABS.map(t=>[`workbook:${t.id}`,1]))};
    const allowed=respond(`Bearer ${token}`,{runId:'3edcf2fe-9ca6-4f6f-842d-51b85b488590',expected});
    assert.equal(allowed.status,200);
    assert.equal(allowed.body.ok,true);
  } finally {module.stop();db.close();}
});
