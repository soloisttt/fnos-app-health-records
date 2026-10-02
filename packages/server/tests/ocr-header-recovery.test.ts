import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../database/client.ts';
import { duplicatedOcrResultName, recoverHeaderAlignedTable } from '../services/ocr-table-structure.ts';
import { rebuildOcrPages } from '../services/ai-input-planner.service.ts';
import { mappedOcrMeasurement, mappedOcrResultCells } from '../services/ocr-table-columns.ts';

test('paired tables retain independent headers, empty cells and evidence groups', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-paired-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const raw = [
      ['项目名称', '', '结果', '单位', '参考区间', '项目名称', '结果', '单位', '参考区间'],
      ['合成项目甲', '【深圳HR】', '12', 'U/L', '0-30', '合成项目乙', '24', 'mg/L', '0-40'],
      ['合成项目丙', '', '', 'U/L', '0-30', '合成项目丁', '36', '', '0-40'],
    ].flatMap((cells, row) => cells.flatMap((text, column) => text ? [{
      id: `${row}-${column}`, text, confidence: .99,
      box: [column * 200, row * 100, column * 200 + 100, row * 100 + 20],
      tableCell: { table: 'table_0', row, column, columns: 9 },
    }] : []));
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
    const left = page.lines.find(line => line.sourceLineIds.includes('1-0'))!;
    const right = page.lines.find(line => line.sourceLineIds.includes('1-5'))!;
    assert.equal(left.candidateKind, 'scalar');
    assert.equal(right.candidateKind, 'scalar');
    assert.deepEqual(mappedOcrMeasurement(left.text, left.tableHeaderText), { name: '合成项目甲', result: '12' }, JSON.stringify({ text: left.text, header: left.tableHeaderText, scoped: left.projectHeaderCells }));
    assert.deepEqual(mappedOcrMeasurement(right.text, right.tableHeaderText), { name: '合成项目乙', result: '24' });
    assert.equal(left.text.includes('HR'), false);
    assert.equal(left.sourceLineIds.includes('1-1'), true);
    assert.equal(left.sourceLineIds.includes('1-6'), false);
    const empty = page.lines.find(line => line.sourceLineIds.includes('2-0'))!;
    assert.deepEqual(mappedOcrResultCells(empty.text, empty.tableHeaderText), []);
    assert.equal(empty.localObservations.length, 0);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

function fixture() {
  return [
    ['缩写', '项目名称', '结果', '单位', '参考区间', '方法学'],
    ['A', '合成项目甲', '12', 'U/L', '0-30', '方法甲'],
    ['B', '合成项目乙', '24', 'ml/min/1.73m²≥60', '', '方法乙'],
    ['C', '合成项目丙', '', 'U/L', '0-40', '方法丙'],
  ].flatMap((cells, row) => cells.flatMap((text, column) => text ? [{
    id: `${row}-${column}`, text, confidence: .99, tableUnsafe: true,
    box: [column * 200, row * 100, column * 200 + (text.includes('≥') ? 210 : 100), row * 100 + 20],
  }] : []));
}

test('recovers explicit result columns without borrowing reference values or altering OCR', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-header-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    const raw = fixture();
    raw.push({ id: 'reference-wrap', text: '增高30-50', confidence: .99, tableUnsafe: true, box: [800, 130, 900, 150] });
    const original = JSON.stringify(raw);
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: original }]);
    const first = page.lines.find(line => line.sourceLineIds.includes('1-1'))!;
    const second = page.lines.find(line => line.sourceLineIds.includes('2-1'))!;
    const empty = page.lines.find(line => line.sourceLineIds.includes('3-1'))!;
    assert.equal(first.tableStructureUnsafe, false);
    assert.equal(first.sourceCells[2].text, '12');
    assert.match(first.sourceCells[4].text, /增高30-50/);
    assert.equal(second.sourceCells[3].text, 'ml/min/1.73m²');
    assert.equal(second.sourceCells[4].text, '≥60');
    assert.deepEqual(second.sourceCells[4].sourceLineIds, ['2-3']);
    assert.equal(second.candidateKind, 'scalar');
    assert.equal(empty.tableStructureUnsafe, true);
    assert.equal(empty.localObservations.length, 0);
    assert.equal(JSON.stringify(raw), original);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

test('recovers rows touching the header and results with abnormal arrows', () => {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-header-touching-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try {
    // 真实布局：首个数据行与表头相贴（top = 表头 bottom - 1），结果带 ↑↓ 异常箭头
    const rows = [
      [{ text: '项目名称', x: 19 }, { text: '缩写', x: 326 }, { text: '结果', x: 473 }, { text: '单位', x: 600 }, { text: '参考区间', x: 775 }],
      [{ text: '★合成项目甲', x: 21 }, { text: 'FTA', x: 326 }, { text: '33.37', x: 473 }, { text: 'pmol/L', x: 620 }, { text: '3.5~7', x: 775 }],
      [{ text: '★合成项目乙', x: 23 }, { text: 'FTB', x: 326 }, { text: '↑79.55', x: 473 }, { text: 'pmol/L', x: 620 }, { text: '10~22', x: 775 }],
    ];
    const raw = rows.flatMap((cells, row) => cells.map(({ text, x }, column) => ({
      id: `${row}-${column}`, text, confidence: .99, tableUnsafe: true,
      box: [x, 85 + row * 24 + (row === 1 ? -1 : 0), x + 90, 105 + row * 24],
    })));
    const [page] = rebuildOcrPages([{ pageId: 'synthetic', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
    const first = page.lines.find(line => line.sourceLineIds.includes('1-0'))!;
    const second = page.lines.find(line => line.sourceLineIds.includes('2-0'))!;
    assert.equal(first.tableStructureUnsafe, false);
    assert.equal(second.tableStructureUnsafe, false);
    assert.equal(first.candidateKind, 'scalar');
    assert.equal(second.candidateKind, 'scalar');
    assert.match(mappedOcrMeasurement(first.text, first.tableHeaderText)?.name ?? '', /合成项目甲/);
    assert.match(mappedOcrMeasurement(second.text, second.tableHeaderText)?.result ?? '', /79\.55/);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
});

test('ambiguous result and crossed columns stay unsafe while independent header regions recover', () => {
  const raw = fixture();
  const duplicate = [...raw, { ...raw.find(line => line.id === '1-2')!, id: 'duplicate', text: '99' }];
  assert.equal(recoverHeaderAlignedTable(duplicate).find(line => line.id === '1-1')?.tableUnsafe, true);
  const crossed = raw.map(line => line.id === '1-2' ? { ...line, box: [350, 100, 650, 120] } : line);
  assert.equal(recoverHeaderAlignedTable(crossed).find(line => line.id === '1-1')?.tableUnsafe, true);
  const repeated = [...raw, { ...raw[1], id: 'second-header', box: [1800, 0, 1900, 20] }];
  const recovered = recoverHeaderAlignedTable(repeated);
  assert.equal(recovered.find(line => line.id === '1-1')?.tableUnsafe, false);
  assert.equal(recovered.find(line => line.id === 'second-header')?.tableUnsafe, true);
  const missingHeader = raw.filter(line => line.text !== '结果');
  assert.equal(recoverHeaderAlignedTable(missingHeader), missingHeader);
  const usefulGrid = raw.map((line, i) => ({ ...line, tableUnsafe: i === 0, tableCell: { table: 'table_0', row: 1, column: 0, columns: 6 } }));
  assert.equal(recoverHeaderAlignedTable(usefulGrid), usefulGrid);
});

function coordinatePanel(prefix: string, x: number, top: number, rows: string[][], slope = 0) {
  const positions = [0, 180, 310, 430, 560];
  return rows.flatMap((cells, row) => cells.flatMap((text, col) => {
    if (!text) return [];
    const left = x + positions[col], y = top + row * 48 + positions[col] * slope;
    return [{ id: `${prefix}-${row}-${col}`, text, confidence: .99, tableUnsafe: true,
      box: [left, y, left + 90, y + 22] }];
  }));
}
function withPlanner(fn: () => void) {
  const storage = mkdtempSync(join(tmpdir(), 'ocr-adaptive-'));
  const previous = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = storage;
  try { fn(); } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previous;
    rmSync(storage, { recursive: true, force: true });
  }
}

test('recovers skewed parallel panels with different column orders even without a table model', () => withPlanner(() => {
  const raw = [
    ...coordinatePanel('left', 30, 20, [
      ['项目名称', '结果', '参考值', '单位'],
      ['合成项目甲', '12.5', '0-99', 'U/L'],
      ['合成项目乙', '0', '1-9', ''],
    ], .025),
    ...coordinatePanel('right', 760, 29, [
      ['项目名称', '单位', '结果', '参考区间'],
      ['合成项目丙', 'mg/L', '24.6', '10-88'],
      ['合成项目丁', '', '<0.2', ''],
    ], -.015),
  ];
  const scaledAndShuffled = [...raw].reverse().map(line => {
    const [left, top, right, bottom] = line.box.map((value, index) => value * .4 + (index % 2 ? 210 : 130));
    return { ...line, box: [[left, top], [right, top], [right, bottom], [left, bottom]] };
  });
  for (const annotated of [raw, raw.map(({ tableUnsafe, ...line }) => line), scaledAndShuffled]) {
    const before = JSON.stringify(annotated);
    const [page] = rebuildOcrPages([{ pageId: 'parallel', pageNumber: 1, linesJson: before }]);
    const facts = page.lines.flatMap(line => line.localObservations);
    assert.equal(facts.length, 4);
    for (const [name, value, resultId, headerId] of [
      ['合成项目甲', 12.5, 'left-1-1', 'left-0-1'],
      ['合成项目乙', 0, 'left-2-1', 'left-0-1'],
      ['合成项目丙', 24.6, 'right-1-2', 'right-0-2'],
      ['合成项目丁', .2, 'right-2-2', 'right-0-2'],
    ] as const) {
      const fact = facts.find(item => item.itemName === name)!;
      assert.equal(fact?.numericValue, value);
      assert.deepEqual(fact.sourceMap.result.sourceLineIds, [resultId]);
      assert.deepEqual(fact.sourceMap.result.headerSourceLineIds, [headerId]);
    }
    assert.equal(facts.find(item => item.itemName === '合成项目丁')?.resultText, '<0.2');
    assert.equal(facts.find(item => item.itemName === '合成项目乙')?.unit, null);
    assert.equal(JSON.stringify(annotated), before);
  }
}));

test('keeps missing, duplicate, low-confidence and crossed results out of local extraction', () => withPlanner(() => {
  const raw = coordinatePanel('unsafe', 0, 0, [
    ['项目名称', '结果', '参考值', '单位'],
    ['缺值项目', '', '0-88', 'U/L'],
    ['冲突项目', '12', '0-88', 'U/L'],
    ['低置信项目', '13', '0-88', 'U/L'],
    ['越界项目', '14', '0-88', 'U/L'],
    ['正常项目', '15', '0-88', 'U/L'],
  ]).map(line => line.id === 'unsafe-3-1' ? { ...line, confidence: .4 }
    : line.id === 'unsafe-4-1' ? { ...line, box: [100, 192, 280, 214] } : line);
  raw.push({ ...raw.find(line => line.id === 'unsafe-2-1')!, id: 'duplicate-result', text: '99' });
  const [page] = rebuildOcrPages([{ pageId: 'unsafe', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
  assert.deepEqual(page.lines.flatMap(line => line.localObservations).map(item => item.itemName), ['正常项目']);
  for (const row of [1, 2, 3, 4]) {
    const line = page.lines.find(line => line.sourceLineIds.includes(`unsafe-${row}-0`))!;
    assert.equal(line.tableStructureUnsafe, true);
    assert.equal(line.localObservations.length, 0);
  }
}));

test('deduplicates overlapping name/result OCR and repeated code labels with original source ids', () => withPlanner(() => {
  const raw = coordinatePanel('overlap', 0, 0, [
    ['代码', '项目名称', '结果', '参考值', '单位'],
    ['', '合成项目甲12.5', '12.5', '0-20', 'U/L'],
    ['', 'ABC DEF ABC_DEF', '22', '0-30', 'fL'],
    ['', '合成项目丙99', '23', '0-30', 'U/L'],
    ['', '维生素B12', '12', '0-30', ''],
    ['', 'CA19.9', '19.9', '0-30', ''],
  ]).map(line => line.id === 'overlap-1-1' || line.id === 'overlap-3-1'
    ? { ...line, box: [180, line.box[1], 400, line.box[3]] }
    : line.id === 'overlap-2-1' ? { ...line, box: [80, line.box[1], 275, line.box[3]] } : line);
  const before = JSON.stringify(raw);
  const [page] = rebuildOcrPages([{ pageId: 'overlap', pageNumber: 1, linesJson: before }]);
  const facts = page.lines.flatMap(line => line.localObservations);
  assert.equal(facts.find(item => item.itemName === '合成项目甲')?.numericValue, 12.5);
  assert.equal(facts.find(item => item.itemName === 'ABC_DEF')?.numericValue, 22);
  assert.deepEqual(facts.find(item => item.itemName === '合成项目甲')?.sourceMap.item.sourceLineIds, ['overlap-1-1']);
  assert.deepEqual(facts.find(item => item.itemName === '合成项目甲')?.sourceMap.result.sourceLineIds, ['overlap-1-2']);
  assert.equal(facts.some(item => item.itemName.startsWith('合成项目丙')), false);
  assert.ok(facts.some(item => item.itemName === '维生素B12'));
  assert.ok(facts.some(item => item.itemName === 'CA19.9'));
  assert.equal(duplicatedOcrResultName('维生素B12','12'), null);
  assert.equal(duplicatedOcrResultName('维生素D3','3'), null);
  assert.equal(duplicatedOcrResultName('CA19.9','19.9'), null);
  assert.equal(JSON.stringify(raw), before);
}));

test('recovers a failed neighbour and later sections without touching a useful model grid', () => withPlanner(() => {
  const good = coordinatePanel('good', 0, 0, [['项目名称', '结果', '单位'], ['合成项目甲', '11', 'U/L']])
    .map(line => ({ ...line, tableUnsafe: false, tableCell: { table: 'table_0', row: Number(line.id.split('-')[1]), column: Number(line.id.split('-')[2]), columns: 3 } }));
  const failed = coordinatePanel('failed', 760, 0, [['项目名称', '结果', '单位'], ['合成项目乙', '22', 'mg/L']]);
  const later = coordinatePanel('later', 0, 200, [['项目名称', '单位', '结果'], ['合成项目丙', 'g/L', '33']]);
  const raw = [...good, ...failed, ...later];
  const recovered = recoverHeaderAlignedTable(raw);
  for (const line of good) assert.equal(recovered.find(item => item.id === line.id), line);
  const [page] = rebuildOcrPages([{ pageId: 'mixed', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
  const facts = page.lines.flatMap(line => line.localObservations);
  assert.equal(facts.length, 3);
  assert.equal(facts.find(item => item.itemName === '合成项目乙')?.numericValue, 22);
  assert.equal(facts.find(item => item.itemName === '合成项目丙')?.numericValue, 33);
}));

test('does not reinterpret history as a result or administrative dates as measurements', () => withPlanner(() => {
  const raw = coordinatePanel('history', 0, 0, [
    ['项目名称', '历史结果', '结果', '单位', '参考值'],
    ['合成项目甲', '99', '', 'U/L', '0-100'],
    ['送检日期：2025-01-01', '12', '34', 'U/L', '0-100'],
  ]);
  assert.equal(recoverHeaderAlignedTable(raw), raw);
  const [page] = rebuildOcrPages([{ pageId: 'history', pageNumber: 1, linesJson: JSON.stringify(raw) }]);
  assert.equal(page.lines.flatMap(line => line.localObservations).length, 0);
  assert.equal(page.lines.find(line => line.text.includes('送检日期'))?.candidate, false);
}));

test('splits reference/unit OCR only at an explicit printed unit and preserves both source links', () => withPlanner(() => {
  const raw = coordinatePanel('joined', 0, 0, [
    ['项目名称', '结果', '参考值', '单位'],
    ['合成项目甲', '12', '0-3010^9/L', ''],
    ['合成项目乙', '24', '5~40ng/ml', ''],
    ['合成项目丙', '36', '0-60', ''],
  ]);
  const [page] = rebuildOcrPages([{pageId:'joined',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  const facts = page.lines.flatMap(line => line.localObservations);
  assert.equal(facts.length, 3);
  const first = facts.find(item => item.itemName === '合成项目甲')!;
  assert.equal(first.unit, '10^9/L');
  assert.equal(first.referenceHigh, 30);
  assert.deepEqual(first.sourceMap.unit?.sourceLineIds, ['joined-1-2']);
  assert.deepEqual(first.sourceMap.reference?.sourceLineIds, ['joined-1-2']);
  assert.equal(facts.find(item => item.itemName === '合成项目乙')?.unit, 'ng/ml');
  assert.equal(facts.find(item => item.itemName === '合成项目乙')?.referenceHigh, 40);
  assert.equal(facts.find(item => item.itemName === '合成项目丙')?.unit, null);
}));
