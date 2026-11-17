import { timingSafeEqual } from 'node:crypto';
import { ACCOUNTING_TAB, TECH_TABS, buildSnapshot } from './model.js';

const ACCOUNTING_KEY = 'accounting';
const WORKBOOK_PREFIX = 'workbook:';
const CHUNK_MAX_ROWS = 120;
const MAX_CELL_LENGTH = 30000;
const MAX_COLUMNS = 80;
const MAX_SOURCE_ROWS = 25000;
const RUN_LIFETIME_MS = 12 * 60 * 1000;
const permittedKeys = [ACCOUNTING_KEY, ...TECH_TABS.map((tab) => WORKBOOK_PREFIX + tab.id)];
const forbidden = (message, status = 400) => Object.assign(new Error(message), { status });
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function isPushConfigured(env = process.env) {
  return typeof env.TECH_PUSH_IMPORT_TOKEN === 'string' && env.TECH_PUSH_IMPORT_TOKEN.length >= 32;
}

export function samePushToken(token, expected) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}

function normalizeRows(rows, limit = CHUNK_MAX_ROWS) {
  if (!Array.isArray(rows) || !rows.length || rows.length > limit)
    throw forbidden('Некорректное число строк в пакете');
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS)
      throw forbidden('Некорректная строка таблицы');
    return row.map((cell) => {
      if (cell !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof cell))
        throw forbidden('В таблице обнаружен неподдерживаемый тип данных');
      const value = String(cell ?? '');
      if (value.length > MAX_CELL_LENGTH) throw forbidden('Слишком длинное значение ячейки');
      return value;
    });
  });
}

function validRunId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw forbidden('Некорректный идентификатор импорта');
  return value;
}

function validateCounts(expected) {
  if (!isRecord(expected) || Object.keys(expected).length !== permittedKeys.length ||
      !permittedKeys.every((key) => Number.isInteger(expected[key]) && expected[key] >= 1 && expected[key] <= 210))
    throw forbidden('Необходимо передать количество частей для всех семи вкладок и бухгалтерии');
  if (Object.values(expected).reduce((sum, n) => sum + n, 0) > 850)
    throw forbidden('Превышен допустимый размер импорта');
  return Object.fromEntries(permittedKeys.map((key) => [key, expected[key]]));
}

function snapshotFromSources(sources, at = new Date().toISOString()) {
  const accounting = sources[ACCOUNTING_KEY];
  const workbook = Object.fromEntries(TECH_TABS.map(tab => [tab.title, sources[WORKBOOK_PREFIX + tab.id]]));
  if (!Array.isArray(accounting) || accounting.length < 1 ||
      !Array.isArray(workbook[TECH_TABS[0].title]) || workbook[TECH_TABS[0].title].length < 2)
    throw forbidden('Нет бухгалтерского листа или основной вкладки; импорт отменён', 422);
  for (const [key, rows] of Object.entries(sources)) {
    if (!permittedKeys.includes(key) || !Array.isArray(rows) || rows.length < 1 || rows.length > MAX_SOURCE_ROWS)
      throw forbidden('Не все исходные вкладки переданы полностью', 422);
  }
  return buildSnapshot(workbook, accounting, at);
}

export function createTechnicalPushReceiver(store, env = process.env) {
  // One in-flight import per Node process; a restart discards only uncommitted data.
  // The last complete SQLite snapshot is never affected by a partial import.
  let active = null;
  let activeAccounting = null;
  // An interrupted HTTP import must not block every subsequent edit forever.
  const expireStaleRuns = () => {
    if (active && Date.now() - active.started >= RUN_LIFETIME_MS) active = null;
    if (activeAccounting && Date.now() - activeAccounting.started >= RUN_LIFETIME_MS)
      activeAccounting = null;
  };
  const validateSourceKey = (key) => {
    if (!permittedKeys.includes(key)) throw forbidden('Неизвестный лист импорта');
    return key;
  };
  const validateExisting = (snapshot, {allowLargeRemoval = false} = {}) => {
    const counts = store.meta('counts');
    const previous = counts ? JSON.parse(counts).total : 0;
    if (!allowLargeRemoval && previous > 20 && snapshot.rows.length < previous * 0.3 && env.TECH_ALLOW_LARGE_REMOVAL !== 'true')
      throw forbidden('Резко сократилось число записей. Предыдущие данные сохранены; проверьте исходные таблицы.', 409);
  };
  const checkActive = (runId) => {
    validRunId(runId);
    if (!active || active.id !== runId || Date.now() - active.started > RUN_LIFETIME_MS)
      throw forbidden('Пакет импорта устарел или не был начат. Запустите полный импорт заново.', 409);
    return active;
  };
  const start = ({runId, expected}) => {
    expireStaleRuns();
    validRunId(runId);
    const counts = validateCounts(expected);
    // A new authenticated run may replace an interrupted/incomplete one.
    // Unfinished chunks never change the saved snapshot.
    if (active?.id === runId) return {ok: true, alreadyStarted: true};
    if (activeAccounting && Date.now() - activeAccounting.started < RUN_LIFETIME_MS)
      throw forbidden('Идёт сверка бухгалтерии. Повторите полный импорт позже.', 409);
    active = {id: runId, started: Date.now(), expected: counts, parts: new Map()};
    return {ok: true, requiredSources: permittedKeys.length};
  };
  const chunk = ({runId, key, index, rows}) => {
    const run = checkActive(runId);
    validateSourceKey(key);
    if (!Number.isInteger(index) || index < 0 || index >= run.expected[key])
      throw forbidden('Неверный номер части');
    const normalized = normalizeRows(rows);
    const parts = run.parts.get(key) || new Map();
    const previous = parts.get(index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
      throw forbidden('Повторная часть импорта отличается от исходной', 409);
    parts.set(index, normalized);
    run.parts.set(key, parts);
    return {ok: true, key, index};
  };
  const commit = ({runId}) => {
    const run = checkActive(runId);
    const sources = {};
    for (const key of permittedKeys) {
      const chunks = run.parts.get(key);
      if (!chunks || chunks.size !== run.expected[key])
        throw forbidden(`Не все части ${key} получены; данные не изменены`, 422);
      sources[key] = [];
      for (let i = 0; i < run.expected[key]; i++) {
        if (!chunks.has(i)) throw forbidden(`Пропущена часть ${key}:${i}`, 422);
        sources[key].push(...chunks.get(i));
      }
    }
    const snapshot = snapshotFromSources(sources);
    validateExisting(snapshot);
    store.commitSnapshot(snapshot, sources, { accountingReconciled: true });
    active = null;
    return {ok: true, counts: snapshot.counts, updatedAt: snapshot.updatedAt};
  };
  const patch = ({key, startRow, rows}) => {
    expireStaleRuns();
    validateSourceKey(key);
    if (!Number.isInteger(startRow) || startRow < 1 || startRow > MAX_SOURCE_ROWS)
      throw forbidden('Некорректный номер строки');
    const normalized = normalizeRows(rows, 50);
    if (startRow + normalized.length - 1 > MAX_SOURCE_ROWS)
      throw forbidden('Превышен максимальный номер строки');
    if (active || activeAccounting) throw forbidden('Идёт контрольная сверка. Изменение попадёт в следующий снимок.', 409);
    const sources = store.sourceSnapshot();
    if (!sources) throw forbidden('Сначала выполните полную первоначальную загрузку', 409);
    const existing = sources[key];
    if (!Array.isArray(existing)) throw forbidden('Нет исходного листа', 409);
    if (startRow > existing.length + 50) throw forbidden('Большой разрыв строк, требуется полная сверка', 409);
    const updated = existing.map(row => [...row]);
    for (let i = 0; i < normalized.length; i++) updated[startRow - 1 + i] = normalized[i];
    sources[key] = updated;
    const snapshot = snapshotFromSources(sources);
    validateExisting(snapshot);
    store.commitSnapshot(snapshot, sources, { accountingUpdated: key === ACCOUNTING_KEY });
    return {ok: true, counts: snapshot.counts, updatedAt: snapshot.updatedAt};
  };
  /**
   * Partial full snapshot, strictly scoped to accounting: reconcile additions,
   * moved rows, deleted rows and cleared cells without retransmitting seven
   * independently edited technical tabs. Commit is atomic with the SQLite
   * snapshot; a missing/expired chunk never modifies existing data.
   */
  const startAccounting = ({runId, expected}) => {
    expireStaleRuns();
    validRunId(runId);
    if (!Number.isInteger(expected) || expected < 1 || expected > 210)
      throw forbidden('Неверное число частей бухгалтерской сверки');
    if (activeAccounting?.id === runId) return {ok: true, alreadyStarted: true};
    if (active && Date.now() - active.started < RUN_LIFETIME_MS)
      throw forbidden('Идёт полный импорт, повторите сверку позже.', 409);
    activeAccounting = {id: runId, started: Date.now(), expected, parts: new Map()};
    return {ok: true, expected};
  };
  const accountingChunk = ({runId, index, rows}) => {
    validRunId(runId);
    const run = activeAccounting;
    if (!run || run.id !== runId || Date.now() - run.started > RUN_LIFETIME_MS)
      throw forbidden('Сверка бухгалтерии не начата или устарела.', 409);
    if (!Number.isInteger(index) || index < 0 || index >= run.expected)
      throw forbidden('Неверный номер части бухгалтерской сверки');
    const normalized = normalizeRows(rows);
    if (normalized.some(row => row.length !== 26))
      throw forbidden('Бухгалтерские строки должны содержать ровно 26 позиций');
    const previous = run.parts.get(index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
      throw forbidden('Повторная часть бухгалтерии отличается от исходной.', 409);
    run.parts.set(index, normalized);
    return {ok: true, index};
  };
  const commitAccounting = ({runId}) => {
    validRunId(runId);
    const run = activeAccounting;
    if (!run || run.id !== runId || Date.now() - run.started > RUN_LIFETIME_MS)
      throw forbidden('Сверка бухгалтерии не начата или устарела.', 409);
    if (active) throw forbidden('Идёт полный импорт, повторите сверку позже.', 409);
    if (run.parts.size !== run.expected)
      throw forbidden('Не все части бухгалтерской сверки получены.', 422);
    const rows = [];
    for (let i = 0; i < run.expected; i++) {
      if (!run.parts.has(i)) throw forbidden('Пропущена часть бухгалтерской сверки.', 422);
      rows.push(...run.parts.get(i));
    }
    if (!rows.length || rows.length > MAX_SOURCE_ROWS)
      throw forbidden('Некорректная бухгалтерская таблица.', 422);
    const sources = store.sourceSnapshot();
    if (!sources) throw forbidden('Сначала выполните первоначальную загрузку семи вкладок.', 409);
    sources[ACCOUNTING_KEY] = rows;
    const snapshot = snapshotFromSources(sources);
    validateExisting(snapshot);
    store.commitSnapshot(snapshot, sources, { accountingReconciled: true });
    activeAccounting = null;
    return {ok: true, counts: snapshot.counts, updatedAt: snapshot.updatedAt};
  };
  return {start, chunk, commit, patch, startAccounting, accountingChunk, commitAccounting};
}

export const technicalSourceKeys = () => [...permittedKeys];
export const accountingSourceKey = ACCOUNTING_KEY;
export const technicalSourceKey = (tabId) => WORKBOOK_PREFIX + tabId;
export const sourceAccountingTab = ACCOUNTING_TAB;
