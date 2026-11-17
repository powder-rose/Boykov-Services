import { createHash } from 'node:crypto';

// File IDs are supplied by server-only environment variables; never commit private links.
export const ACCOUNTING_FILE = '';
export const WORKBOOK_FILE = '';
export const ACCOUNTING_TAB = 'П/О СЭР ТО';

// These are the seven original "ДОП.РАБОТЫ" tabs. No other accounting tabs are imported.
export const TECH_TABS = [
  { id: '723255987', title: 'СЭР ТО МСК РЕГИОНЫ', codeColumn: 6, locked: [6, 7, 9, 10, 12, 13, 14, 15, 17] },
  { id: '0', title: 'ДОПЫ', codeColumn: null, locked: [] },
  { id: '878613942', title: 'Электрики', codeColumn: null, locked: [] },
  { id: '1298694826', title: 'ЭЛ.ЗАПАС', codeColumn: null, locked: [] },
  { id: '2075067225', title: 'КАЛЦРУ РОССИЯ', codeColumn: 0, locked: [0] },
  { id: '1299045180', title: 'КАЛЦРУ ДОПЫ СПБ', codeColumn: 0, locked: [0] },
  { id: '846887197', title: 'КАЛЦРУ ДОПЫ МСК', codeColumn: 0, locked: [0] },
];

// 0-based positions from the real accounting "П/О СЭР ТО" header row.
export const ACCOUNTING_FIELDS = [
  { key: 'irina', label: 'Комментарии Ирины', sourceIndex: 6, targetIndex: null },
  { key: 'code', label: 'Код объекта', sourceIndex: 1, targetIndex: 6 },
  { key: 'city', label: 'Город', sourceIndex: 15, targetIndex: 15 },
  { key: 'object', label: 'Наименование объекта', sourceIndex: 16, targetIndex: 9 },
  { key: 'address', label: 'Адрес', sourceIndex: 17, targetIndex: 10 },
  { key: 'company', label: 'Наименование компании', sourceIndex: 2, targetIndex: 7 },
  { key: 'email', label: 'Почта', sourceIndex: 23, targetIndex: 13 },
  { key: 'phone', label: 'Телефон', sourceIndex: 25, targetIndex: 12 },
  { key: 'frequency', label: 'Периодичность', sourceIndex: 22, targetIndex: 14 },
  { key: 'monthlyCost', label: 'Стоимость в месяц', sourceIndex: 20, targetIndex: 17 },
];

export const normalizeCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
const val = (v) => String(v ?? '').trim();
const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);

export function buildSnapshot(workbookRanges, accountingRows, updatedAt = new Date().toISOString()) {
  const matches = new Map();
  // Accounting row 1 is the header. Never take another accounting tab.
  for (const [index, row] of accountingRows.entries()) {
    if (index === 0) continue;
    const code = normalizeCode(row[1]);
    if (!code) continue;
    if (!matches.has(code)) matches.set(code, []);
    matches.get(code).push({ row: index + 1, values: row });
  }
  const sheets = [];
  const rows = [];
  for (const tab of TECH_TABS) {
    const grid = workbookRanges[tab.title] || [];
    const header = (grid[0] || []).map(val);
    const width = Math.max(header.length, ...grid.map((r) => r.length), 0);
    const headers = Array.from({ length: width }, (_, i) => header[i] || `Столбец ${i + 1}`);
    sheets.push({ id: tab.id, title: tab.title, headers, lastSync: updatedAt });
    const rawRows = grid.slice(1).map((r, i) => ({ index: i + 2, values: Array.from({ length: width }, (_, n) => val(r[n])) }))
      .filter(({ values }) => values.some(Boolean));
    const codeCounts = new Map();
    for (const r of rawRows) {
      const code = tab.codeColumn === null ? '' : normalizeCode(r.values[tab.codeColumn]);
      if (code) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    }
    // Keep existing work rows authoritative for their code, and add an
    // accounting-only row only when this code is absent from the work sheet.
    // Notes/custom values survive its later appearance in ДОП.РАБОТЫ because
    // the record key stays `code:${code}` instead of using the row number.
    const workCodes = tab.id === TECH_TABS[0].id
      ? new Set([...codeCounts.keys()]) : null;
    const seenIds = new Set();
    for (const r of rawRows) {
      const code = tab.codeColumn === null ? '' : normalizeCode(r.values[tab.codeColumn]);
      const duplicates = code && codeCounts.get(code) > 1;
      // When a work-order code repeats, include its request number if unique.
      let key = code && !duplicates ? `code:${code}` : code && val(r.values[1]) ? `order:${code}:${sha(val(r.values[1]) + '|' + val(r.values[2]))}`
        : `record:${sha(JSON.stringify(r.values.slice(0, 8)))}`;
      if (seenIds.has(key)) key = `row:${r.index}:${sha(JSON.stringify(r.values))}`;
      seenIds.add(key);
      // Only the main service tab uses the accounting object namespace.
      // Other tabs (e.g. CALZEDONIA) may reuse codes for unrelated jobs.
      const accountingEnabled = tab.id === TECH_TABS[0].id;
      const found = accountingEnabled && code ? matches.get(code) || [] : [];
      const matchStatus = !accountingEnabled ? 'separate-tab' : !code ? 'no-code'
        : found.length === 1 ? 'linked' : found.length > 1 ? 'ambiguous' : 'not-found';
      const accounting = matchStatus === 'linked'
        ? Object.fromEntries(ACCOUNTING_FIELDS.map((field) => [field.key, val(found[0].values[field.sourceIndex])]))
        : null;
      rows.push({ tabId: tab.id, key, rowNumber: r.index, code, values: r.values, accounting,
        matchStatus, accountingRow: matchStatus === 'linked' ? found[0].row : null });
    }
    if (tab.id === TECH_TABS[0].id) {
      let appended = 0;
      // A new company may be entered before its code is assigned. Show it as
      // "no-code" rather than silently dropping the row. Such provisional rows
      // are not automatically joined to technical jobs: a unique code remains
      // necessary to link records safely across the two source files.
      for (let sourceIndex = 1; sourceIndex < accountingRows.length; sourceIndex++) {
        const source = {row: sourceIndex + 1, values: accountingRows[sourceIndex]};
        const code = normalizeCode(source.values[1]);
        const candidates = code ? matches.get(code) || [] : [];
        // Duplicate accounting codes are unsafe to mirror as distinct objects:
        // they may belong to one customer but the source does not identify which.
        if (code && candidates.length !== 1) continue;
        if (code && workCodes.has(code)) continue;
        const identity = [2, 16, 17].some(index => val(source.values[index]));
        if (!code && !identity) continue; // do not make fake objects from blank separators
        const uniqueCode = Boolean(code);
        const matchStatus = code ? 'linked' : 'no-code';
        const accounting = Object.fromEntries(ACCOUNTING_FIELDS.map(field =>
          [field.key, val(source.values[field.sourceIndex])]));
        const values = Array(width).fill('');
        for (const field of ACCOUNTING_FIELDS) {
          if (field.targetIndex !== null && field.targetIndex < width)
            values[field.targetIndex] = accounting[field.key];
        }
        appended++;
        rows.push({tabId: tab.id,
          key: uniqueCode ? `code:${code}` : `accounting-row:${source.row}`,
          rowNumber: grid.length + appended, code, values, accounting,
          matchStatus, accountingRow: source.row });
      }
    }
  }
  return { sheets, rows, updatedAt, counts: {
    total: rows.length, linked: rows.filter((r) => r.matchStatus === 'linked').length,
    ambiguous: rows.filter((r) => r.matchStatus === 'ambiguous').length,
  } };
}

export function effectiveValues(row, overrides) {
  const values = [...row.values];
  for (const o of overrides) values[o.columnIndex] = o.value;
  // Replace mirrored Google row fields with accounting values, never with legacy manual values.
  if (row.tabId === TECH_TABS[0].id && row.accounting) {
    for (const field of ACCOUNTING_FIELDS) {
      if (field.targetIndex !== null) values[field.targetIndex] = row.accounting[field.key];
    }
  }
  return values;
}

export function canEditColumn(tabId, index, width) {
  const tab = TECH_TABS.find((t) => t.id === String(tabId));
  return !!tab && Number.isInteger(index) && index >= 0 && index < width && !tab.locked.includes(index);
}
