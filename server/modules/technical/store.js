import { createHash, randomBytes } from 'node:crypto';
import { ACCOUNTING_FIELDS, TECH_TABS, canEditColumn, effectiveValues } from './model.js';

const hashToken = (v) => createHash('sha256').update(v).digest('hex');
const toJSON = (v) => JSON.stringify(v ?? null);
const fromJSON = (v, fallback = null) => v == null ? fallback : JSON.parse(v);
const errorOf = (message, status=400) => Object.assign(new Error(message), {status});
const ALLOWED_COLORS = new Set(['none', 'amber', 'blue', 'green', 'rose']);
// Google columns are never modified. New working columns have separate, stable IDs.
const MAX_VISIBLE_WORK_COLUMNS = 50;


export function createTechnicalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS technical_sheets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, headers_json TEXT NOT NULL, last_sync TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technical_rows (
      sheet_id TEXT NOT NULL, record_key TEXT NOT NULL, row_number INTEGER NOT NULL,
      code TEXT NOT NULL, values_json TEXT NOT NULL, accounting_json TEXT,
      match_status TEXT NOT NULL, accounting_row INTEGER,
      PRIMARY KEY(sheet_id, record_key)
    );
    CREATE INDEX IF NOT EXISTS technical_rows_position ON technical_rows(sheet_id, row_number);
    CREATE TABLE IF NOT EXISTS technical_overrides (
      sheet_id TEXT NOT NULL, record_key TEXT NOT NULL, column_index INTEGER NOT NULL,
      value TEXT NOT NULL, author_login TEXT NOT NULL, author_name TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(sheet_id, record_key, column_index)
    );
    CREATE TABLE IF NOT EXISTS technical_notes (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, record_key TEXT NOT NULL,
      author_login TEXT NOT NULL, author_name TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_notes_lookup ON technical_notes(sheet_id, record_key, created_at);
    CREATE TABLE IF NOT EXISTS technical_audit (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, record_key TEXT NOT NULL,
      column_index INTEGER NOT NULL, old_value TEXT, new_value TEXT NOT NULL,
      author_login TEXT NOT NULL, author_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_audit_lookup ON technical_audit(sheet_id, record_key, created_at);
    CREATE TABLE IF NOT EXISTS technical_users (
      login TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
      password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      failed INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS technical_sessions (
      token_hash TEXT PRIMARY KEY, login TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technical_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS technical_source_data (
      source_key TEXT PRIMARY KEY, rows_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS technical_custom_columns (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, sort_order INTEGER NOT NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(sheet_id, sort_order)
    );
    CREATE INDEX IF NOT EXISTS technical_custom_columns_sheet
      ON technical_custom_columns(sheet_id, sort_order);
    CREATE TABLE IF NOT EXISTS technical_custom_values (
      sheet_id TEXT NOT NULL, record_key TEXT NOT NULL, column_id TEXT NOT NULL,
      value TEXT NOT NULL, author_name TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(sheet_id, record_key, column_id)
    );
    CREATE TABLE IF NOT EXISTS technical_custom_audit (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, record_key TEXT NOT NULL,
      column_id TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL,
      author_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_custom_audit_lookup
      ON technical_custom_audit(sheet_id, record_key, created_at);
    CREATE TABLE IF NOT EXISTS technical_column_colors (
      sheet_id TEXT NOT NULL, column_key TEXT NOT NULL, color TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(sheet_id, column_key)
    );
    -- Цвет отдельной ячейки хранится независимо от цвета всего столбца
    -- и не удаляется при обновлении снимка Google.
    CREATE TABLE IF NOT EXISTS technical_cell_colors (
      sheet_id TEXT NOT NULL, record_key TEXT NOT NULL, column_key TEXT NOT NULL,
      color TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(sheet_id, record_key, column_key)
    );
    CREATE INDEX IF NOT EXISTS technical_cell_colors_lookup
      ON technical_cell_colors(sheet_id, record_key);
  `);
  // Мягкое удаление пользовательского столбца. Значения и история сохраняются
  // в SQLite и могут быть восстановлены. Исходные поля Google не затрагиваются.
  if (!db.prepare('PRAGMA table_info(technical_custom_columns)').all()
    .some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE technical_custom_columns ADD COLUMN archived_at TEXT');
  }
  const upsertSheet = db.prepare(`INSERT INTO technical_sheets VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, headers_json=excluded.headers_json, last_sync=excluded.last_sync`);
  const insertRow = db.prepare(`INSERT INTO technical_rows
    (sheet_id, record_key, row_number, code, values_json, accounting_json, match_status, accounting_row)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const meta = (key) => db.prepare('SELECT value FROM technical_meta WHERE key = ?').get(key)?.value || null;
  const setMeta = (key, value) => db.prepare(`INSERT INTO technical_meta VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));

  function commitSnapshot(snapshot, sourceRows = null, { accountingUpdated = false, accountingReconciled = false } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM technical_rows; DELETE FROM technical_sheets;');
      for (const sheet of snapshot.sheets) upsertSheet.run(sheet.id, sheet.title, toJSON(sheet.headers), snapshot.updatedAt);
      for (const row of snapshot.rows) insertRow.run(row.tabId, row.key, row.rowNumber, row.code,
        toJSON(row.values), toJSON(row.accounting), row.matchStatus, row.accountingRow);
      if (sourceRows) {
        db.exec('DELETE FROM technical_source_data;');
        const sourceInsert = db.prepare('INSERT INTO technical_source_data VALUES (?, ?, ?)');
        for (const [key, rows] of Object.entries(sourceRows))
          sourceInsert.run(key, toJSON(rows), snapshot.updatedAt);
      }
      setMeta('updatedAt', snapshot.updatedAt);
      setMeta('counts', toJSON(snapshot.counts));
      setMeta('lastError', '');
      if (accountingUpdated || accountingReconciled) {
        setMeta('accountingLastSuccessAt', snapshot.updatedAt);
      }
      if (accountingReconciled) {
        setMeta('accountingLastReconcileAt', snapshot.updatedAt);
        setMeta('accountingLastError', '');
        setMeta('accountingLastErrorAt', '');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const sourceSnapshot = () => {
    const items = db.prepare('SELECT source_key, rows_json FROM technical_source_data').all();
    // All seven working tabs and the accounting tab must have been committed together.
    if (items.length !== TECH_TABS.length + 1) return null;
    return Object.fromEntries(items.map(r => [r.source_key, fromJSON(r.rows_json, [])]));
  };

  const deserialize = (r) => r && ({
    tabId: r.sheet_id, key: r.record_key, rowNumber: r.row_number,
    code: r.code, values: fromJSON(r.values_json, []),
    accounting: fromJSON(r.accounting_json), matchStatus: r.match_status,
    accountingRow: r.accounting_row,
  });
  const findRow = (sheetId, recordKey) => deserialize(db.prepare(
    'SELECT * FROM technical_rows WHERE sheet_id = ? AND record_key = ?'
  ).get(sheetId, recordKey));
  const overridesFor = (id, key) => db.prepare(`SELECT column_index AS columnIndex, value,
    author_name AS authorName, updated_at AS updatedAt FROM technical_overrides WHERE sheet_id=? AND record_key=?`).all(id, key);
  const customColumnsFor = (tabId) => db.prepare(`
    SELECT id, title, sort_order AS sortOrder, created_at AS createdAt
      FROM technical_custom_columns
      WHERE sheet_id = ? AND archived_at IS NULL ORDER BY sort_order, id
  `).all(tabId);
  const archivedCustomColumnsFor = (tabId) => db.prepare(`
    SELECT id, title, archived_at AS archivedAt
      FROM technical_custom_columns
      WHERE sheet_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id
  `).all(tabId);
  const customValuesFor = (tabId, recordKey) => Object.fromEntries(
    db.prepare(`SELECT v.column_id AS columnId, v.value FROM technical_custom_values v
      JOIN technical_custom_columns c ON c.id = v.column_id AND c.sheet_id = v.sheet_id
      WHERE v.sheet_id = ? AND v.record_key = ? AND c.archived_at IS NULL`)
      .all(tabId, recordKey).map(r => [r.columnId,r.value]));
  const columnColors = () => Object.fromEntries(
    db.prepare('SELECT sheet_id AS sheetId, column_key AS columnKey, color FROM technical_column_colors')
      .all().map(c => [`${c.sheetId}:${c.columnKey}`, c.color]));
  const cellColorsFor = (tabId, recordKey) => Object.fromEntries(
    db.prepare(`SELECT column_key AS columnKey, color FROM technical_cell_colors
      WHERE sheet_id=? AND record_key=?`).all(tabId,recordKey).map(c=>[c.columnKey,c.color]));
  // Одним SQL-запросом получаем цвета всей видимой страницы; не делаем
  // отдельный запрос на каждую из 100 строк при каждом обновлении интерфейса.
  const cellColorsForRows = (tabId, keys) => {
    const result = new Map();
    if (!keys.length) return result;
    const placeholders = keys.map(()=>'?').join(',');
    const entries = db.prepare(`SELECT record_key AS recordKey, column_key AS columnKey, color
      FROM technical_cell_colors WHERE sheet_id=? AND record_key IN (${placeholders})`).all(tabId,...keys);
    for (const entry of entries) {
      if (!result.has(entry.recordKey)) result.set(entry.recordKey,{});
      result.get(entry.recordKey)[entry.columnKey] = entry.color;
    }
    return result;
  };
  const snapshotSheets = () => TECH_TABS.map((tab) => {
    const s = db.prepare('SELECT * FROM technical_sheets WHERE id=?').get(tab.id);
    return { id: tab.id, title: tab.title, headers: fromJSON(s?.headers_json, []),
      customColumns: customColumnsFor(tab.id),
      archivedCustomColumns: archivedCustomColumnsFor(tab.id),
      rowCount: db.prepare('SELECT count(*) AS n FROM technical_rows WHERE sheet_id=?').get(tab.id).n,
      lastSync: s?.last_sync || null };
  });

  const requireTab = (tabId) => {
    if (!TECH_TABS.some(t => t.id === String(tabId))) throw errorOf('Неизвестная вкладка');
    return String(tabId);
  };
  const addCustomColumn = (tabId, rawTitle) => {
    const id = requireTab(tabId);
    if (typeof rawTitle !== 'string') throw errorOf('Укажите название нового поля');
    const title = rawTitle.trim().replace(/\s+/g, ' ');
    if (!title || title.length > 80) throw errorOf('Название поля — от 1 до 80 символов');
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const source = db.prepare('SELECT headers_json FROM technical_sheets WHERE id=?').get(id);
      if (!source) throw errorOf('Сначала загрузите данные из Google',409);
      const original = fromJSON(source.headers_json, []);
      const existing = customColumnsFor(id);
      if (original.length + existing.length >= MAX_VISIBLE_WORK_COLUMNS)
        throw errorOf(`На вкладке уже ${MAX_VISIBLE_WORK_COLUMNS} столбцов. Достигнут установленный предел.`,409);
      if ([...original,...existing.map(c=>c.title)].some(name => String(name).trim().toLocaleLowerCase('ru') === title.toLocaleLowerCase('ru')))
        throw errorOf('Поле с таким названием уже есть',409);
      // Архивные поля занимают старые sort_order: учитываем их при создании.
      const order = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n
        FROM technical_custom_columns WHERE sheet_id=?`).get(id).n;
      const columnId = randomBytes(12).toString('hex');
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO technical_custom_columns
        (id,sheet_id,sort_order,title,created_at) VALUES (?,?,?,?,?)`)
        .run(columnId,id,order,title,createdAt);
      db.exec('COMMIT');
      result = {id:columnId,title,sortOrder:order,createdAt};
    } catch(e) {db.exec('ROLLBACK');throw e;}
    return result;
  };
  // Удаление и восстановление применяются ТОЛЬКО к созданным в сервисе полям.
  // Данные не стираем: это снижает риск случайной потери рабочих записей.
  const archiveCustomColumn = (tabId, columnId, expectedArchived) => {
    const id = requireTab(tabId);
    if (typeof columnId !== 'string' || !/^[0-9a-f]{24}$/.test(columnId))
      throw errorOf('Можно удалить только добавленное поле', 403);
    const found = db.prepare(`SELECT id, title, archived_at AS archivedAt
      FROM technical_custom_columns WHERE sheet_id=? AND id=?`).get(id,columnId);
    if (!found) throw errorOf('Исходные и бухгалтерские столбцы удалять нельзя',403);
    if (typeof expectedArchived === 'boolean' && Boolean(found.archivedAt) !== expectedArchived)
      throw errorOf('Столбец уже изменён другим сотрудником. Обновите страницу.',409);
    if (!found.archivedAt) db.prepare(`UPDATE technical_custom_columns SET archived_at=?
      WHERE sheet_id=? AND id=? AND archived_at IS NULL`).run(new Date().toISOString(),id,columnId);
    return {ok:true,id:columnId,title:found.title,archived:true};
  };
  const restoreCustomColumn = (tabId, columnId, expectedArchived) => {
    const id = requireTab(tabId);
    if (typeof columnId !== 'string' || !/^[0-9a-f]{24}$/.test(columnId))
      throw errorOf('Некорректное поле');
    db.exec('BEGIN IMMEDIATE');
    try {
      const found = db.prepare(`SELECT id,title,archived_at AS archivedAt
        FROM technical_custom_columns WHERE sheet_id=? AND id=?`).get(id,columnId);
      if (!found) throw errorOf('Поле не найдено',404);
      if (typeof expectedArchived === 'boolean' && Boolean(found.archivedAt) !== expectedArchived)
        throw errorOf('Столбец уже изменён другим сотрудником. Обновите страницу.',409);
      if (found.archivedAt) {
        const source = db.prepare('SELECT headers_json FROM technical_sheets WHERE id=?').get(id);
        if (!source) throw errorOf('Сначала загрузите данные из Google',409);
        const existing = customColumnsFor(id);
        if (fromJSON(source.headers_json,[]).length + existing.length >= MAX_VISIBLE_WORK_COLUMNS)
          throw errorOf('Достигнут лимит столбцов',409);
        const duplicate = [...fromJSON(source.headers_json,[]),...existing.map(c=>c.title)]
          .some(name=>String(name).trim().toLocaleLowerCase('ru')===found.title.trim().toLocaleLowerCase('ru'));
        if (duplicate) throw errorOf('Сначала переименуйте совпадающий столбец',409);
        db.prepare(`UPDATE technical_custom_columns SET archived_at=NULL
          WHERE sheet_id=? AND id=?`).run(id,columnId);
      }
      db.exec('COMMIT');
      return {ok:true,id:columnId,title:found.title,archived:false};
    } catch(error){db.exec('ROLLBACK');throw error;}
  };
  const columnExists = (id, columnKey) => {
    if (typeof columnKey !== 'string') return false;
    if (columnKey === 'accounting:irina') return id === TECH_TABS[0].id;
    if (/^sheet:(0|[1-9][0-9]*)$/.test(columnKey)) {
      const headers = fromJSON(db.prepare('SELECT headers_json FROM technical_sheets WHERE id=?').get(id)?.headers_json, []);
      return Number(columnKey.slice(6)) < headers.length;
    }
    if (/^custom:[0-9a-f]{24}$/.test(columnKey)) return !!db.prepare(
      'SELECT 1 FROM technical_custom_columns WHERE sheet_id=? AND id=? AND archived_at IS NULL'
    ).get(id,columnKey.slice(7));
    return false;
  };
  const setColumnColor = (tabId, columnKey, color, expectedColor) => {
    const id = requireTab(tabId);
    if (!ALLOWED_COLORS.has(color)) throw errorOf('Неподдерживаемый цвет столбца');
    if (!columnExists(id,columnKey)) throw errorOf('Столбец не найден',404);
    const existing = db.prepare('SELECT color FROM technical_column_colors WHERE sheet_id=? AND column_key=?').get(id,columnKey);
    const currentColor = existing?.color || 'none';
    if (expectedColor !== undefined && currentColor !== expectedColor)
      throw errorOf('Цвет столбца уже изменён другим сотрудником. Обновите таблицу.',409);
    if (color === 'none') db.prepare('DELETE FROM technical_column_colors WHERE sheet_id=? AND column_key=?').run(id,columnKey);
    else db.prepare(`INSERT INTO technical_column_colors VALUES (?,?,?,?)
      ON CONFLICT(sheet_id,column_key) DO UPDATE SET color=excluded.color,updated_at=excluded.updated_at`)
      .run(id,columnKey,color,new Date().toISOString());
    return {columnKey,color};
  };
  const setCellColor = (tabId, recordKey, columnKey, color, expectedColor) => {
    const id = requireTab(tabId);
    if (!ALLOWED_COLORS.has(color)) throw errorOf('Неподдерживаемый цвет ячейки');
    if (!findRow(id,recordKey)) throw errorOf('Строка не найдена',404);
    if (!columnExists(id,columnKey)) throw errorOf('Столбец не найден',404);
    const existing = db.prepare(`SELECT color FROM technical_cell_colors
      WHERE sheet_id=? AND record_key=? AND column_key=?`).get(id,recordKey,columnKey);
    const currentColor = existing?.color || 'none';
    if (expectedColor !== undefined && currentColor !== expectedColor)
      throw errorOf('Цвет ячейки уже изменён другим сотрудником. Обновите таблицу.',409);
    if (color === 'none') db.prepare(`DELETE FROM technical_cell_colors
      WHERE sheet_id=? AND record_key=? AND column_key=?`).run(id,recordKey,columnKey);
    else db.prepare(`INSERT INTO technical_cell_colors VALUES (?,?,?,?,?)
      ON CONFLICT(sheet_id,record_key,column_key) DO UPDATE SET
        color=excluded.color,updated_at=excluded.updated_at`)
      .run(id,recordKey,columnKey,color,new Date().toISOString());
    return {recordKey,columnKey,color};
  };
  const editCustomCell = (tabId,recordKey,columnId,value,person,expectedValue) => {
    const id = requireTab(tabId);
    if (typeof columnId !== 'string' || !/^[0-9a-f]{24}$/.test(columnId) ||
        !db.prepare(`SELECT 1 FROM technical_custom_columns
          WHERE sheet_id=? AND id=? AND archived_at IS NULL`).get(id,columnId))
      throw errorOf('Рабочее поле не найдено',404);
    if (!findRow(id,recordKey)) throw errorOf('Строка не найдена',404);
    if (typeof value !== 'string' || value.length > 10000) throw errorOf('Максимум 10 000 символов');
    const timestamp = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare(`SELECT value FROM technical_custom_values
        WHERE sheet_id=? AND record_key=? AND column_id=?`).get(id,recordKey,columnId);
      if (expectedValue !== undefined && (previous?.value ?? '') !== expectedValue)
        throw errorOf('Поле уже изменено другим сотрудником. Обновите карточку.',409);
      db.prepare(`INSERT INTO technical_custom_values VALUES (?,?,?,?,?,?)
        ON CONFLICT(sheet_id,record_key,column_id) DO UPDATE SET
        value=excluded.value,author_name=excluded.author_name,updated_at=excluded.updated_at`)
        .run(id,recordKey,columnId,value,person.name,timestamp);
      db.prepare('INSERT INTO technical_custom_audit VALUES (?,?,?,?,?,?,?,?)')
        .run(randomBytes(16).toString('hex'),id,recordKey,columnId,previous?.value ?? '',value,person.name,timestamp);
      db.exec('COMMIT');
    } catch(e){db.exec('ROLLBACK');throw e;}
    return {columnId,value,authorName:person.name,updatedAt:timestamp};
  };
  const readRow = (tabId, key) => {
    const row = findRow(tabId, key);
    if (!row) return null;
    const overrides = overridesFor(tabId, key);
    return { ...row, values: effectiveValues(row, overrides),
      customValues: customValuesFor(tabId,key), cellColors:cellColorsFor(tabId,key),
      editMeta: overrides, lockedColumns: TECH_TABS.find(t=>t.id===tabId)?.locked || [] };
  };
  const allRows = (tabId, { q='', offset=0, limit=60, matched='all' }={}) => {
    const rows = db.prepare('SELECT * FROM technical_rows WHERE sheet_id = ? ORDER BY row_number').all(tabId)
      .map(deserialize).filter((r) => matched === 'all' || r.matchStatus === matched);
    const needle = String(q).trim().toLocaleLowerCase('ru');
    const customText = needle ? new Map() : null;
    if (customText) {
      for (const r of db.prepare(`SELECT v.record_key AS recordKey, v.value
        FROM technical_custom_values v JOIN technical_custom_columns c
        ON c.id=v.column_id AND c.sheet_id=v.sheet_id
        WHERE v.sheet_id=? AND c.archived_at IS NULL`).all(tabId))
        customText.set(r.recordKey, `${customText.get(r.recordKey) || ''} ${r.value}`);
    }
    const filtered = needle ? rows.filter((r) =>
      [r.code, ...r.values, ...Object.values(r.accounting || {}), customText.get(r.key) || '']
        .join(' ').toLocaleLowerCase('ru').includes(needle)) : rows;
    const selected = filtered.slice(offset, offset + limit);
    const colors = cellColorsForRows(tabId,selected.map(r=>r.key));
    return { total: filtered.length, items: selected.map((r) => ({ ...r,
      values: effectiveValues(r, overridesFor(r.tabId, r.key)),
      customValues: customValuesFor(r.tabId,r.key),
      cellColors: colors.get(r.key) || {},
      noteCount: db.prepare('SELECT count(*) AS n FROM technical_notes WHERE sheet_id=? AND record_key=?').get(r.tabId,r.key).n,
    })) };
  };
  const recordDetail = (id, key) => {
    const item = readRow(id, key);
    if (!item) return null;
    const notes = db.prepare(`SELECT id, author_login AS authorLogin, author_name AS authorName,
      body, created_at AS createdAt FROM technical_notes WHERE sheet_id=? AND record_key=? ORDER BY created_at DESC, id DESC LIMIT 200`).all(id,key);
    const changes = db.prepare(`SELECT id, column_index AS columnIndex, old_value AS oldValue,
      new_value AS newValue, author_name AS authorName, created_at AS createdAt FROM technical_audit
      WHERE sheet_id=? AND record_key=? ORDER BY created_at DESC, id DESC LIMIT 150`).all(id,key);
    const customChanges = db.prepare(`SELECT a.id, -1 AS columnIndex, c.title AS columnTitle,
      a.old_value AS oldValue, a.new_value AS newValue,
      a.author_name AS authorName, a.created_at AS createdAt
      FROM technical_custom_audit a LEFT JOIN technical_custom_columns c ON c.id=a.column_id
      WHERE a.sheet_id=? AND a.record_key=? ORDER BY a.created_at DESC, a.id DESC LIMIT 150`).all(id,key);
    const history = [...changes, ...customChanges].sort((a,b)=>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0,150);
    return { ...item, notes, changes:history };
  };
  const addNote = (id, key, body, person) => {
    const value = String(body ?? '').trim();
    if (!value || value.length > 4000) throw Object.assign(new Error('Заметка должна содержать от 1 до 4000 символов'), { status: 400 });
    if (!findRow(id,key)) throw Object.assign(new Error('Объект не найден'), {status:404});
    const idNote = randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    db.prepare('INSERT INTO technical_notes VALUES (?, ?, ?, ?, ?, ?, ?)').run(idNote,id,key,person.login,person.name,value,timestamp);
    return {id:idNote,authorLogin:person.login,authorName:person.name,body:value,createdAt:timestamp};
  };
  const editCell = (id, key, columnIndex, text, person, expectedValue) => {
    const row = readRow(id, key);
    if (!row) throw Object.assign(new Error('Строка не найдена'), { status:404 });
    const index = Number(columnIndex);
    if (!canEditColumn(id, index, row.values.length)) throw Object.assign(new Error('Бухгалтерское или служебное поле нельзя менять'), {status:403});
    if (typeof text !== 'string' || text.length > 10000) throw Object.assign(new Error('Максимум 10 000 символов'), {status:400});
    const value = text;
    const oldValue = row.values[index] || '';
    if (expectedValue !== undefined && oldValue !== expectedValue)
      throw errorOf('Поле уже изменено другим сотрудником. Обновите карточку.',409);
    const timestamp = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO technical_overrides VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(sheet_id,record_key,column_index) DO UPDATE SET
        value=excluded.value, author_login=excluded.author_login,
        author_name=excluded.author_name, updated_at=excluded.updated_at`)
        .run(id,key,index,value,person.login,person.name,timestamp);
      db.prepare('INSERT INTO technical_audit VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomBytes(16).toString('hex'),id,key,index,oldValue,value,person.login,person.name,timestamp);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return { columnIndex:index, value, authorName:person.name, updatedAt:timestamp };
  };
  function createUser(login, name, passwordHash, role='editor') {
    if (!/^[a-z0-9_.-]{3,40}$/.test(login) || !name || name.length>100 || !['editor','admin'].includes(role))
      throw new Error('Некорректный логин, имя или роль');
    db.prepare(`INSERT INTO technical_users(login,name,role,password_hash) VALUES (?,?,?,?)
      ON CONFLICT(login) DO UPDATE SET name=excluded.name,role=excluded.role,password_hash=excluded.password_hash,
      active=1,failed=0,blocked_until=0`).run(login,name,role,passwordHash);
  }
  const findUser = (login) => db.prepare('SELECT * FROM technical_users WHERE login=? AND active=1').get(login);
  const authSession = (cookie) => {
    if (!/^[a-f0-9]{64}$/.test(cookie || '')) return null;
    const record = db.prepare(`SELECT u.login, u.name, u.role FROM technical_sessions s
      JOIN technical_users u ON u.login=s.login WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`)
      .get(hashToken(cookie),Date.now());
    return record || null;
  };
  function createSession(login) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM technical_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO technical_sessions VALUES (?, ?, ?)').run(hashToken(token),login,Date.now()+12*3600*1000);
    return token;
  }
  const deleteSession = (token) => { if(token) db.prepare('DELETE FROM technical_sessions WHERE token_hash=?').run(hashToken(token)); };
  const failedLogin = (login) => db.prepare('UPDATE technical_users SET failed=failed+1,blocked_until=CASE WHEN failed+1>=8 THEN ? ELSE blocked_until END WHERE login=?')
    .run(Date.now()+15*60*1000,login);
  const resetLogin = (login) => db.prepare('UPDATE technical_users SET failed=0,blocked_until=0 WHERE login=?').run(login);
  const usersCount = () => db.prepare('SELECT count(*) AS n FROM technical_users WHERE active=1').get().n;
  return { commitSnapshot, sourceSnapshot, readRow, allRows, recordDetail, snapshotSheets, addNote, editCell,
    customColumnsFor, archivedCustomColumnsFor, columnColors, addCustomColumn,
    archiveCustomColumn, restoreCustomColumn, setColumnColor, setCellColor, editCustomCell,
    meta,setMeta,createUser,findUser,authSession,createSession,deleteSession,failedLogin,resetLogin,usersCount,
    accountingFields: ACCOUNTING_FIELDS };
}
