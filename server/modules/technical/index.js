import { timingSafeEqual } from 'node:crypto';
import { createTechnicalStore } from './store.js';
import { buildSnapshot, TECH_TABS } from './model.js';
import { isGoogleConfigured, readTechnicalGoogleSheets } from './google.js';
import { isPushConfigured, createTechnicalPushReceiver, samePushToken } from './push.js';

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};
const safeNumber = (v, fallback, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};
const inputError = (message) => Object.assign(new Error(message), { status: 400 });

export function createTechnicalModule(db, options = {}) {
  const store = createTechnicalStore(db);
  const env = options.technicalEnv || process.env;
  const mode = options.technicalReader ? 'test-reader' : isPushConfigured(env) ? 'apps-script'
    : isGoogleConfigured(env) ? 'google-api' : 'none';
  const reader = options.technicalReader || (() => readTechnicalGoogleSheets({ env }));
  const configured = () => mode !== 'none';
  const receiver = createTechnicalPushReceiver(store, env);
  let running = null;
  let lastAttempt = 0;
  let stopping = false;
  const syncNow = async () => {
    if (stopping) return null;
    if (mode === 'apps-script') throw Object.assign(new Error('Данные отправляются из Apps Script. Запустите boykovTechPushNow в Google Таблице.'), {status:409});
    if (!configured()) throw Object.assign(new Error('Источник данных не подключён'), {status:503});
    if (running) return running;
    lastAttempt = Date.now();
    running = (async () => {
      try {
        const { workbook, accounting } = await reader();
        if (!Array.isArray(accounting) || accounting.length < 2 || !Array.isArray(workbook?.[TECH_TABS[0].title]) || workbook[TECH_TABS[0].title].length < 2) {
          throw new Error('Google вернул неполную бухгалтерскую или основную техническую вкладку. Предыдущий снимок сохранён.');
        }
        const snapshot = buildSnapshot(workbook, accounting);
        const previous = store.meta('counts');
        const previousTotal = previous ? JSON.parse(previous).total : 0;
        if (previousTotal > 20 && snapshot.rows.length < previousTotal * 0.3 && env.TECH_ALLOW_LARGE_REMOVAL !== 'true') {
          throw new Error('Количество строк резко сократилось. Импорт остановлен для защиты данных; проверьте исходные Google Таблицы.');
        }
        if (!stopping) store.commitSnapshot(snapshot);
        console.log(`Техотдел: синхронизировано ${snapshot.counts.total} строк из 7 вкладок`);
        return snapshot.counts;
      } catch (error) {
        if (!stopping) store.setMeta('lastError', String(error.message || error).slice(0, 500));
        console.error('Техотдел: ошибка синхронизации:', error.message);
        throw error;
      } finally { running = null; }
    })();
    return running;
  };
  const refreshSafely = () => { void syncNow().catch(() => {}); };
  const timer = options.disableTechnicalTimer || !['google-api', 'test-reader'].includes(mode) ? null : setInterval(refreshSafely, 5 * 60_000);
  timer?.unref();
  if (!options.disableTechnicalStartupSync && ['google-api', 'test-reader'].includes(mode)) setImmediate(refreshSafely);
  const stop = () => { stopping = true; if (timer) clearInterval(timer); };

  const webhook = (req, res) => {
    if (mode === 'apps-script') return res.status(410).json({error:'Используйте /hooks/technical/import/* для прямой передачи данных'});
    const secret = env.TECH_SYNC_WEBHOOK_TOKEN;
    if (!secret || secret.length < 32) return res.status(404).json({error: 'Маршрут недоступен'});
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ') || !sameSecret(header.slice(7), secret))
      return res.status(403).json({error:'Доступ запрещён'});
    if (Date.now() - lastAttempt > 15_000) refreshSafely();
    return res.status(202).json({ ok:true, message:'Запрос на сверку принят' });
  };

  // Apps Script pushes only authenticated, structured data. This endpoint never
  // requests data from Google and never writes anything back to Sheets.
  function registerPushHooks(app) {
    const routes = [
      ['start', 'start'], ['chunk', 'chunk'], ['commit', 'commit'], ['patch', 'patch'],
      ['accounting/start', 'startAccounting'],
      ['accounting/chunk', 'accountingChunk'],
      ['accounting/commit', 'commitAccounting'],
    ];
    for (const [route, action] of routes) {
      app.post(`/hooks/technical/import/${route}`, (req, res) => {
        if (mode !== 'apps-script') return res.status(404).json({error:'Приём данных не настроен'});
        const authorization = String(req.headers.authorization || '');
        if (!authorization.startsWith('Bearer ') ||
            !samePushToken(authorization.slice(7), env.TECH_PUSH_IMPORT_TOKEN))
          return res.status(403).json({error:'Неверный токен синхронизации'});
        if (!String(req.headers['content-type'] || '').startsWith('application/json'))
          return res.status(415).json({error:'Ожидается JSON'});
        try { return res.json(receiver[action](req.body || {})); }
        catch (error) {
          const status = [400,403,409,422].includes(error.status) ? error.status : 500;
          if (status === 500) console.error('Техотдел: ошибка приёма данных:',error.name);
          return res.status(status).json({error:status === 500 ? 'Ошибка приёма данных' : error.message});
        }
      });
    }
  }

  // No separate technical login: the existing Boykov-services session protects /api.
  // Names are supplied voluntarily and therefore must not be represented as
  // verified employee identity. Preserve legacy technical_users rows/history.
  const selfReportedPerson = (raw) => {
    if (raw != null && typeof raw !== 'string') throw inputError('Имя автора должно быть строкой');
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (name.length > 80) throw inputError('Имя автора — не более 80 символов');
    return { login: 'self-reported', name: name || 'Без подписи', role: 'editor' };
  };
  const validateTab = (req, res, next) => TECH_TABS.some(t=>t.id===req.params.id) ? next() : next(inputError('Неизвестная вкладка'));

  function registerRoutes(app) {
    // Intentionally no /api/technical/login, /logout or user session routes.
    // Authentication is already enforced by installAuth(app) for every /api path.
    app.get('/api/technical/meta',(req,res)=>res.json({
      configured:configured(), syncMode:mode, sheets:store.snapshotSheets(), updatedAt:store.meta('updatedAt'),
      counts:store.meta('counts') ? JSON.parse(store.meta('counts')) : {total:0,linked:0,ambiguous:0},
      lastError:store.meta('lastError') || null, accountingFields:store.accountingFields,
      columnColors:store.columnColors(),
      source: mode === 'apps-script' ? 'Google Apps Script → Boykov-services; только чтение' : 'Google Sheets → Boykov-services; только чтение',
    }));
    app.get('/api/technical/tabs/:id/rows',validateTab,(req,res)=>{
      const q = String(req.query.q || '').slice(0,120);
      const offset=safeNumber(req.query.offset,0,1_000_000);
      const limit=safeNumber(req.query.limit,60,100) || 60;
      const matched=['all','linked','ambiguous','no-code','not-found','separate-tab'].includes(req.query.matched) ? req.query.matched : 'all';
      res.json(store.allRows(req.params.id,{q,offset,limit,matched}));
    });
    app.get('/api/technical/tabs/:id/rows/:key',validateTab,(req,res)=>{
      if (req.params.key.length>256) throw inputError('Некорректный идентификатор');
      const row=store.recordDetail(req.params.id,req.params.key);
      if (!row) return res.status(404).json({error:'Запись не найдена'});
      return res.json(row);
    });
    // И столбцы, и отдельные ячейки имеют общий цвет на сервере.
    // Ширина остаётся личной настройкой браузера.
    app.patch('/api/technical/tabs/:id/columns/color',validateTab,(req,res,next)=>{
      try { res.json(store.setColumnColor(req.params.id,req.body?.columnKey,req.body?.color,req.body?.expectedColor)); }
      catch(error) { next(error); }
    });
    app.patch('/api/technical/tabs/:id/rows/:key/color',validateTab,(req,res,next)=>{
      try { res.json(store.setCellColor(req.params.id,req.params.key,req.body?.columnKey,req.body?.color,req.body?.expectedColor)); }
      catch(error) { next(error); }
    });
    app.post('/api/technical/tabs/:id/columns',validateTab,(req,res,next)=>{
      try { res.status(201).json(store.addCustomColumn(req.params.id,req.body?.title)); }
      catch(error) { next(error); }
    });
    app.delete('/api/technical/tabs/:id/columns/:columnId',validateTab,(req,res,next)=>{
      try { res.json(store.archiveCustomColumn(req.params.id,req.params.columnId,req.body?.expectedArchived)); }
      catch(error) { next(error); }
    });
    app.post('/api/technical/tabs/:id/columns/:columnId/restore',validateTab,(req,res,next)=>{
      try { res.json(store.restoreCustomColumn(req.params.id,req.params.columnId,req.body?.expectedArchived)); }
      catch(error) { next(error); }
    });
    app.patch('/api/technical/tabs/:id/rows/:key/custom/:columnId',validateTab,(req,res,next)=>{
      try { res.json(store.editCustomCell(req.params.id,req.params.key,req.params.columnId,req.body?.value,selfReportedPerson(req.body?.author),req.body?.expectedValue)); }
      catch(error) {next(error);}
    });
    app.post('/api/technical/tabs/:id/rows/:key/notes',validateTab,(req,res,next)=>{
      try { res.status(201).json(store.addNote(req.params.id,req.params.key,req.body?.body,selfReportedPerson(req.body?.author))); }
      catch(error) {next(error);}
    });
    app.patch('/api/technical/tabs/:id/rows/:key/cells',validateTab,(req,res,next)=>{
      try { res.json(store.editCell(req.params.id,req.params.key,req.body?.columnIndex,req.body?.value,selfReportedPerson(req.body?.author),req.body?.expectedValue)); }
      catch(error) {next(error);}
    });

  }
  return { store, registerRoutes, registerPushHooks, webhook, syncNow, stop };
}
