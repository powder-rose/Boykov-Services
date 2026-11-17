/**
 * BOYKOV-SERVICES / ТЕХОТДЕЛ
 * Отдельный файл в Apps Script бухгалтерской таблицы.
 * Не заменяет существующие функции ФНС и старую синхронизацию.
 *
 * Секреты задаются через Project Settings -> Script properties:
 *   BOYKOV_TECH_SERVER_URL = https://your-domain.example
 *   BOYKOV_TECH_PUSH_TOKEN = тот же секрет, что TECH_PUSH_IMPORT_TOKEN в .env
 *
 * ВЫПОЛНЯЙТЕ:
 *   1) setupBoykovTechPush    - один раз, создаёт триггеры
 *   2) boykovTechPushNow     - первый полный импорт
 *   3) boykovTechSyncAccountingNow - отдельная полная сверка бухгалтерии
 *   4) boykovTechDiagnostics - проверка автоматических триггеров
 */

const BOYKOV_TECH_ACCOUNTING_ID = '19ls1mrxtFD9gb18MZm8aTR_BEAA-LXulZfrUEZWL02E';
const BOYKOV_TECH_WORKBOOK_ID = '1-1F68x3sE3uxknDMJEGlc6YtuJ9YgsDRqJutofJdoL4';
const BOYKOV_TECH_ACCOUNTING_TAB = 'П/О СЭР ТО';
// Only these 10 fields are sent from accounting (zero-based column indexes).
const BOYKOV_TECH_ACCOUNTING_FIELDS = [1,2,6,15,16,17,20,22,23,25];
const BOYKOV_TECH_WORK_TABS = [
  {id: '723255987', title: 'СЭР ТО МСК РЕГИОНЫ'},
  {id: '0', title: 'ДОПЫ'},
  {id: '878613942', title: 'Электрики'},
  {id: '1298694826', title: 'ЭЛ.ЗАПАС'},
  {id: '2075067225', title: 'КАЛЦРУ РОССИЯ'},
  {id: '1299045180', title: 'КАЛЦРУ ДОПЫ СПБ'},
  {id: '846887197', title: 'КАЛЦРУ ДОПЫ МСК'}
];

/** Ничего не пишет в Google: читает два файла и отправляет копию в Boykov-services. */
function boykovTechPushNow() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const config = boykovTechConfig_();
    const accounting = SpreadsheetApp.openById(BOYKOV_TECH_ACCOUNTING_ID);
    const workbook = SpreadsheetApp.openById(BOYKOV_TECH_WORKBOOK_ID);
    const inputs = [{key:'accounting', rows:boykovTechReadAccounting_(accounting.getSheetByName(BOYKOV_TECH_ACCOUNTING_TAB))}];
    BOYKOV_TECH_WORK_TABS.forEach(function(tab) {
      const sheet = workbook.getSheetByName(tab.title);
      if (!sheet) throw new Error('В ДОП.РАБОТЫ не найдена вкладка: ' + tab.title);
      inputs.push({key:'workbook:' + tab.id, rows:boykovTechRead_(sheet)});
    });
    const prepared = inputs.map(function(item) {
      return {key:item.key, parts:boykovTechChunks_(item.rows)};
    });
    const runId = Utilities.getUuid();
    const expected = {};
    prepared.forEach(function(item){ expected[item.key] = item.parts.length; });
    boykovTechPost_(config, 'start', {runId:runId,expected:expected});
    let count = 0;
    prepared.forEach(function(item) {
      item.parts.forEach(function(rows,index) {
        boykovTechPost_(config,'chunk',{runId:runId,key:item.key,index:index,rows:rows});
        count += 1;
      });
    });
    const result=boykovTechPost_(config,'commit',{runId:runId});
    PropertiesService.getScriptProperties().setProperty('BOYKOV_TECH_LAST_SUCCESS', new Date().toISOString());
    PropertiesService.getScriptProperties().deleteProperty('BOYKOV_TECH_LAST_ERROR');
    console.log('BOYKOV_TECH_IMPORT_OK: частей=' + count +
      ', записей=' + (result.counts && result.counts.total) +
      ', связанных=' + (result.counts && result.counts.linked));
  } catch (error) {
    PropertiesService.getScriptProperties().setProperty('BOYKOV_TECH_LAST_ERROR', String(error.message).slice(0,350));
    console.error('BOYKOV_TECH_IMPORT_FAILED: ' + error.message);
    throw error;
  } finally {lock.releaseLock();}
}

/**
 * Полная сверка только бухгалтерии: обрабатывает исправления, удаление строк,
 * перестановки, пустые ячейки, строки без кода и работу других Apps Script.
 * Семь рабочих вкладок не перезагружаются, технические заметки не затрагиваются.
 * Перед первым запуском требуется первоначальный boykovTechPushNow.
 */
function boykovTechSyncAccountingNow() {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(12000)) {
    console.log('BOYKOV_TECH_ACCOUNTING_BUSY: следующее расписание повторит сверку');
    return;
  }
  try {
    const config=boykovTechConfig_();
    const sheet=SpreadsheetApp.openById(BOYKOV_TECH_ACCOUNTING_ID)
      .getSheetByName(BOYKOV_TECH_ACCOUNTING_TAB);
    const rows=boykovTechReadAccounting_(sheet);
    const parts=boykovTechChunks_(rows);
    const runId=Utilities.getUuid();
    boykovTechPost_(config,'accounting/start',{runId:runId,expected:parts.length});
    parts.forEach(function(chunk,index) {
      boykovTechPost_(config,'accounting/chunk',{runId:runId,index:index,rows:chunk});
    });
    const result=boykovTechPost_(config,'accounting/commit',{runId:runId});
    const properties=PropertiesService.getScriptProperties();
    properties.setProperty('BOYKOV_TECH_LAST_ACCOUNTING_SUCCESS',new Date().toISOString());
    properties.deleteProperty('BOYKOV_TECH_LAST_ACCOUNTING_ERROR');
    console.log('BOYKOV_TECH_ACCOUNTING_OK: строк источника='+rows.length+
      ', объектов='+result.counts.total+', связанных='+result.counts.linked);
  } catch(error) {
    PropertiesService.getScriptProperties().setProperty('BOYKOV_TECH_LAST_ACCOUNTING_ERROR',
      String(error.message).slice(0,350));
    console.error('BOYKOV_TECH_ACCOUNTING_FAILED: '+error.message);
    throw error;
  } finally { lock.releaseLock(); }
}

/** Периодически проверяем также семь вкладок ДОП.РАБОТЫ. */
function boykovTechScheduledSync() { boykovTechPushNow(); }
function boykovTechAccountingReconcile() { boykovTechSyncAccountingNow(); }

/** Почти мгновенная отправка ручных изменений из любой из двух таблиц. */
function boykovTechOnEdit(e) {
  if (!e || !e.range || !e.source) return;
  const sheet = e.range.getSheet();
  const id = e.source.getId();
  let key = '';
  if (id === BOYKOV_TECH_ACCOUNTING_ID && sheet.getName() === BOYKOV_TECH_ACCOUNTING_TAB) {
    const from=e.range.getColumn()-1;
    const to=from+e.range.getNumColumns()-1;
    if (!BOYKOV_TECH_ACCOUNTING_FIELDS.some(function(column){return column>=from && column<=to;})) return;
    key='accounting';
  } else if (id === BOYKOV_TECH_WORKBOOK_ID) {
    const tab=BOYKOV_TECH_WORK_TABS.find(function(item){return item.title === sheet.getName();});
    if (tab) key='workbook:' + tab.id;
  }
  if (!key) return;
  if (e.range.getRow()===1 || e.range.getNumRows()>50) {
    if (key==='accounting') boykovTechSyncAccountingNow();
    else boykovTechPushNow();
    return;
  }
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('BOYKOV_TECH_BUSY: изменение попадёт в контрольную сверку');
    return;
  }
  try {
    const width=Math.max(1,Math.min(sheet.getLastColumn(),80));
    const startRow=e.range.getRow();
    const rows=key==='accounting'
      ? boykovTechReadAccounting_(sheet,startRow,e.range.getNumRows())
      : sheet.getRange(startRow,1,e.range.getNumRows(),width).getDisplayValues();
    boykovTechPost_(boykovTechConfig_(),'patch',{key:key,startRow:startRow,rows:rows});
    PropertiesService.getScriptProperties().setProperty('BOYKOV_TECH_LAST_EDIT_SUCCESS',
      String(Date.now()));
    PropertiesService.getScriptProperties().deleteProperty('BOYKOV_TECH_LAST_EDIT_ERROR');
    console.log('BOYKOV_TECH_PATCH_OK: '+sheet.getName()+' '+e.range.getA1Notation());
  } catch(error) {
    PropertiesService.getScriptProperties().setProperty('BOYKOV_TECH_LAST_EDIT_ERROR',
      String(error.message).slice(0,350));
    console.error('BOYKOV_TECH_PATCH_FAILED: '+error.message);
    // Контрольная полная сверка устранит пропущенные изменения.
    throw error;
  } finally {lock.releaseLock();}
}

/**
 * INSERT_ROW / REMOVE_ROW: перечитываем бухгалтерию целиком, чтобы удалённые
 * строки действительно исчезали. EDIT — резервный триггер, если onEdit
 * отсутствовал или не отправил патч. Форматирование данные не меняет.
 */
function boykovTechOnChange(e) {
  if (!e || !e.source || e.changeType==='FORMAT') return;
  const isAccounting=e.source.getId()===BOYKOV_TECH_ACCOUNTING_ID;
  if (e.changeType==='EDIT') {
    if (!isAccounting) return; // workbook EDIT обрабатывается onEdit + полный импорт
    const last=Number(PropertiesService.getScriptProperties()
      .getProperty('BOYKOV_TECH_LAST_EDIT_SUCCESS')||0);
    if (Date.now()-last < 25000) return;
    boykovTechSyncAccountingNow();
    return;
  }
  if (isAccounting) boykovTechSyncAccountingNow();
  else boykovTechPushNow();
}

/** Однократная установка триггеров без вмешательства в существующие триггеры ФНС. */
function setupBoykovTechPush() {
  boykovTechConfig_();
  SpreadsheetApp.openById(BOYKOV_TECH_ACCOUNTING_ID).getSheets();
  SpreadsheetApp.openById(BOYKOV_TECH_WORKBOOK_ID).getSheets();
  const names=['boykovTechOnEdit','boykovTechOnChange',
    'boykovTechScheduledSync','boykovTechAccountingReconcile'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (names.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  [BOYKOV_TECH_ACCOUNTING_ID, BOYKOV_TECH_WORKBOOK_ID].forEach(function(id) {
    ScriptApp.newTrigger('boykovTechOnEdit').forSpreadsheet(id).onEdit().create();
    ScriptApp.newTrigger('boykovTechOnChange').forSpreadsheet(id).onChange().create();
  });
  ScriptApp.newTrigger('boykovTechAccountingReconcile').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('boykovTechScheduledSync').timeBased().everyMinutes(30).create();
  console.log('BOYKOV_TECH_TRIGGERS_OK: 2 onEdit + 2 onChange + бухгалтерия каждые 5 минут + 7 вкладок каждые 30 минут');
}

/** Вывести диагностику без токенов и персональных данных. */
function boykovTechDiagnostics() {
  const names=['boykovTechOnEdit','boykovTechOnChange',
    'boykovTechScheduledSync','boykovTechAccountingReconcile'];
  const actual=ScriptApp.getProjectTriggers().map(function(trigger){
    return trigger.getHandlerFunction() + ':' + trigger.getEventType();
  });
  const properties=PropertiesService.getScriptProperties();
  names.forEach(function(name){
    console.log('BOYKOV_TECH_TRIGGER '+name+': '+
      actual.filter(function(row){return row.indexOf(name+':')===0;}).length);
  });
  ['BOYKOV_TECH_LAST_SUCCESS','BOYKOV_TECH_LAST_ERROR',
   'BOYKOV_TECH_LAST_ACCOUNTING_SUCCESS','BOYKOV_TECH_LAST_ACCOUNTING_ERROR',
   'BOYKOV_TECH_LAST_EDIT_ERROR'].forEach(function(key){
      console.log(key+' = '+(properties.getProperty(key)||'нет'));
   });
}

function boykovTechConfig_() {
  const props=PropertiesService.getScriptProperties();
  const url=String(props.getProperty('BOYKOV_TECH_SERVER_URL')||'').replace(/\/+$/,'');
  const token=String(props.getProperty('BOYKOV_TECH_PUSH_TOKEN')||'');
  if (!/^https:\/\/[^/]+/.test(url)) throw new Error('Задайте BOYKOV_TECH_SERVER_URL (HTTPS) в Script Properties');
  if (token.length<32) throw new Error('Задайте BOYKOV_TECH_PUSH_TOKEN (минимум 32 символа) в Script Properties');
  return {url:url, token:token};
}
function boykovTechRead_(sheet) {
  if (!sheet) throw new Error('Исходный лист не найден');
  const height=Math.max(1,sheet.getLastRow());
  const width=Math.max(1,sheet.getLastColumn());
  if (height>25000 || width>80) throw new Error('Слишком большой лист: '+sheet.getName());
  return sheet.getRange(1,1,height,width).getDisplayValues();
}
function boykovTechReadAccounting_(sheet,startRow,numRows) {
  if (!sheet) throw new Error('Бухгалтерский лист не найден');
  startRow=startRow||1;
  const height=numRows||Math.max(1,sheet.getLastRow());
  if (startRow+height-1>25000) throw new Error('Бухгалтерский лист слишком большой');
  const values=sheet.getRange(startRow,1,height,26).getDisplayValues();
  return values.map(function(row) {
    const safe=new Array(26).fill('');
    BOYKOV_TECH_ACCOUNTING_FIELDS.forEach(function(index){safe[index]=row[index]||'';});
    return safe;
  });
}
function boykovTechChunks_(rows) {
  const parts=[];
  let part=[];
  let chars=0;
  rows.forEach(function(row) {
    const size=JSON.stringify(row).length;
    if (size>450000) throw new Error('Слишком длинная строка для передачи');
    if (part.length && (part.length>=100 || chars+size>450000)) {
      parts.push(part);part=[];chars=0;
    }
    part.push(row); chars += size;
  });
  if (part.length) parts.push(part);
  return parts;
}
function boykovTechPost_(config,action,data) {
  const url=config.url+'/hooks/technical/import/'+action;
  for (let attempt=1;attempt<=3;attempt++) {
    const response=UrlFetchApp.fetch(url,{
      method:'post',
      contentType:'application/json; charset=utf-8',
      headers:{Authorization:'Bearer '+config.token},
      payload:JSON.stringify(data),
      muteHttpExceptions:true,
      followRedirects:false,
    });
    const code=response.getResponseCode();
    if (code>=200 && code<300) {
      try {return JSON.parse(response.getContentText());} catch (_) {throw new Error('Сервер вернул неверный JSON');}
    }
    if (attempt<3 && [429,500,502,503,504].indexOf(code)!==-1) {
      Utilities.sleep(attempt*450);continue;
    }
    throw new Error('Boykov-services: HTTP '+code+' ('+response.getContentText().slice(0,350)+')');
  }
}
