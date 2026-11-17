import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TECH_TABS, buildSnapshot, effectiveValues, canEditColumn } from '../server/modules/technical/model.js';

const mainId = '723255987';
const widths = [30, 32, 26, 26, 31, 30, 31];
function makeWorkbook() {
  return Object.fromEntries(TECH_TABS.map((tab, n) => {
    const w = widths[n];
    const header = Array.from({ length: w }, (_, j) => `Поле ${j + 1}`);
    const row = Array(w).fill('');
    row[0] = `первая ячейка ${n}`;
    row[1] = `вторая ячейка ${n}`;
    row[w - 1] = `ПОСЛЕДНЕЕ ПОЛЕ ${n}`;
    if (tab.id === mainId) {
      row[6] = 'D240';
      row[7] = 'устаревшее название';
      row[17] = '1700';
      row[3] = 'Рабочая заметка из оригинала';
    }
    return [tab.title, [header, row]];
  }));
}
const accounting = () => {
  const row = Array(26).fill('');
  row[1] = 'D240'; row[2] = 'ООО ФИССМАН'; row[6] = 'Комментарий Ирины';
  row[15] = 'АНАПА'; row[16] = 'магазин'; row[17] = 'Адрес';
  row[20] = '2200'; row[22] = '1 раз в 3 месяца'; row[23] = 'почта'; row[25] = '89184425298';
  return [Array(26).fill('Заголовок'), row];
};

test('all seven original tabs retain their complete header width and last source column', () => {
  const snapshot = buildSnapshot(makeWorkbook(), accounting());
  assert.equal(snapshot.sheets.length, 7);
  assert.equal(snapshot.rows.length, 7);
  TECH_TABS.forEach((tab, n) => {
    const sheet = snapshot.sheets.find(s => s.id === tab.id);
    const row = snapshot.rows.find(r => r.tabId === tab.id);
    assert.equal(sheet.headers.length, widths[n]);
    assert.equal(row.values.length, widths[n]);
    assert.equal(row.values[widths[n] - 1], `ПОСЛЕДНЕЕ ПОЛЕ ${n}`);
  });
});

test('accounting fields replace the main tab but other original columns and staff edits survive', () => {
  const snapshot = buildSnapshot(makeWorkbook(), accounting());
  const row = snapshot.rows.find(r => r.tabId === mainId);
  assert.equal(row.accounting.irina, 'Комментарий Ирины');
  assert.equal(row.accounting.monthlyCost, '2200');
  const effective = effectiveValues(row, [{ columnIndex: 3, value: 'Техотдел: выполнено' }]);
  assert.equal(effective[3], 'Техотдел: выполнено');
  assert.equal(effective[7], 'ООО ФИССМАН');
  assert.equal(effective[17], '2200');
  assert.equal(effective[29], 'ПОСЛЕДНЕЕ ПОЛЕ 0');
  assert.equal(canEditColumn(mainId, 17, 30), false);
  assert.equal(canEditColumn(mainId, 3, 30), true);
  assert.equal(canEditColumn('2075067225', 0, 31), false);
});

test('the table renders all supplied columns, has horizontal scrolling, pins two and keeps notes', () => {
  const component = readFileSync(new URL('../src/pages/Technical.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/pages/technical.css', import.meta.url), 'utf8');
  assert.match(component, /tableColumns\.map\(\(column\)/);
  assert.match(component, /headers\.map\(\(_, index\) => index\)/);
  assert.doesNotMatch(component, /slice\(0, 4\)/);
  assert.match(component, /tech-sticky-\$\{column\.pinned\}/);
  assert.match(css, /tech-sticky-1/);
  assert.match(css, /tech-sticky-2/);
  assert.match(component, /tech-horizontal-controls/);
  assert.match(component, /Комментарии Ирины/);
  assert.match(component, /tech-note-form/);
  assert.match(component, /openDetail\(item, column\.index\)/);
  assert.match(css, /overflow-x:auto/);
  assert.match(css, /left:144px/);
  assert.match(css, /tech-table-full/);
});
