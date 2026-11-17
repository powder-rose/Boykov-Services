import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/pages/Technical.tsx', root), 'utf8');
const css = readFileSync(new URL('src/pages/technical.css', root), 'utf8');

test('visible cell color entrypoint is accessible by normal left-click', () => {
  assert.match(source, /Окрасить ячейку/);
  assert.match(source, /aria-pressed=\{cellColorMode\}/);
  assert.match(source, /onClickCapture=\{onCellColorClickCapture\}/);
  assert.match(source, /selectCellForColor\(item,column\)/);
  assert.match(source, /updateSharedCellColor/);
  assert.match(source, /onContextMenu=\{\(event\) => openCellPalette\(event,item,column\)\}/);
  assert.match(css, /\.tech-color-quickbar/);
});

test('column coloring and accounting locks remain available', () => {
  assert.match(source, /updateSharedColor/);
  assert.match(source, /tech-header-settings/);
  assert.match(source, /column\.locked/);
  assert.match(source, /tech-cell-tone-/);
  assert.match(source, /Палитра в заголовке|палитра в заголовке/);
});

test('pagination is designed around row ranges, not an unstyled page count', () => {
  assert.match(source, /aria-label="Перейти к диапазону строк"/);
  assert.match(source, /Перейти к строкам/);
  assert.match(source, /tech-page-range-control/);
  assert.match(source, /Показаны строки/);
  assert.match(css, /\.tech-page-range-control/);
  assert.match(css, /appearance:none/);
});

test('verbose technical instruction disappears from footer without losing scroll buttons', () => {
  assert.doesNotMatch(source, /Правый щелчок по ячейке — цвет ячейки/);
  assert.doesNotMatch(source, /Палитра в заголовке — цвет столбца/);
  assert.match(source, /tech-horizontal-buttons/);
  assert.match(source, /scrollHorizontally\(-1\)/);
  assert.match(source, /scrollHorizontally\(1\)/);
});

test('width controls, optional full text and cell color still work without backend mutations', () => {
  assert.match(source, /tech-width-range/);
  assert.match(source, /onResizeStart/);
  assert.match(source, /setFullText\(/);
  assert.match(source, /updateSharedCellColor/);
  assert.match(source, /PAGE_SIZE = 100/);
});
