import { createHash, randomBytes } from 'node:crypto';
import { ACCOUNTING_FIELDS, TECH_TABS, canEditColumn, effectiveValues } from './model.js';

const hashToken = (v) => createHash('sha256').update(v).digest('hex');
const toJSON = (v) => JSON.stringify(v ?? null);
const fromJSON = (v, fallback = null) => v == null ? fallback : JSON.parse(v);

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
  `);
  const upsertSheet = db.prepare(`INSERT INTO technical_sheets VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, headers_json=excluded.headers_json, last_sync=excluded.last_sync`);
  const insertRow = db.prepare(`INSERT INTO technical_rows
    (sheet_id, record_key, row_number, code, values_json, accounting_json, match_status, accounting_row)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const meta = (key) => db.prepare('SELECT value FROM technical_meta WHERE key = ?').get(key)?.value || null;
  const setMeta = (key, value) => db.prepare(`INSERT INTO technical_meta VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));

  function commitSnapshot(snapshot, sourceRows = null) {
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
  const snapshotSheets = () => TECH_TABS.map((tab) => {
    const s = db.prepare('SELECT * FROM technical_sheets WHERE id=?').get(tab.id);
    return { id: tab.id, title: tab.title, headers: fromJSON(s?.headers_json, []),
      rowCount: db.prepare('SELECT count(*) AS n FROM technical_rows WHERE sheet_id=?').get(tab.id).n,
      lastSync: s?.last_sync || null };
  });
  const readRow = (tabId, key) => {
    const row = findRow(tabId, key);
    if (!row) return null;
    const overrides = overridesFor(tabId, key);
    return { ...row, values: effectiveValues(row, overrides),
      editMeta: overrides, lockedColumns: TECH_TABS.find(t=>t.id===tabId)?.locked || [] };
  };
  const allRows = (tabId, { q='', offset=0, limit=60, matched='all' }={}) => {
    const rows = db.prepare('SELECT * FROM technical_rows WHERE sheet_id = ? ORDER BY row_number').all(tabId)
      .map(deserialize).filter((r) => matched === 'all' || r.matchStatus === matched);
    const needle = String(q).trim().toLocaleLowerCase('ru');
    const filtered = needle ? rows.filter((r) =>
      [r.code, ...r.values, ...Object.values(r.accounting || {})].join(' ').toLocaleLowerCase('ru').includes(needle)) : rows;
    const selected = filtered.slice(offset, offset + limit);
    return { total: filtered.length, items: selected.map((r) => ({ ...r,
      values: effectiveValues(r, overridesFor(r.tabId, r.key)),
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
    return { ...item, notes, changes };
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
  const editCell = (id, key, columnIndex, text, person) => {
    const row = readRow(id, key);
    if (!row) throw Object.assign(new Error('Строка не найдена'), { status:404 });
    const index = Number(columnIndex);
    if (!canEditColumn(id, index, row.values.length)) throw Object.assign(new Error('Бухгалтерское или служебное поле нельзя менять'), {status:403});
    if (typeof text !== 'string' || text.length > 10000) throw Object.assign(new Error('Максимум 10 000 символов'), {status:400});
    const value = text;
    const oldValue = row.values[index] || '';
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
    meta,setMeta,createUser,findUser,authSession,createSession,deleteSession,failedLogin,resetLogin,usersCount,
    accountingFields: ACCOUNTING_FIELDS };
}
