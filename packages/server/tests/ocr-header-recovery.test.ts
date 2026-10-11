import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests, getDatabase } from '../database/client.ts';
import { duplicatedOcrResultName, recoverHeaderAlignedTable, uncoveredOcrResultIds } from '../services/ocr-table-structure.ts';
import { rebuildOcrPages, observationFieldConfidenceIssue, trustedOcrNameReviewCandidate } from '../services/ai-input-planner.service.ts';
import { mappedOcrMeasurement, mappedOcrResultCells } from '../services/ocr-table-columns.ts';

test('every headerless field retains its own confidence and weak references do not reject the result', () => withPlanner(() => {
  for (const weak of [0,1,2,3]) {
    const raw = ['ALT','12','U/L','0-40'].map((text,index)=>({id:`raw-${index}`,text,
      box:[index*200,50,index*200+100,70],confidence:index===weak?.1:.99}));
    const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
    const row = page.lines[0];
    assert.equal(row.candidate,true);
    assert.equal(row.localObservations.length,weak===3?1:0,`field ${weak}`);
    const issue = observationFieldConfidenceIssue(row,{itemName:'ALT',resultText:'12',unit:'U/L'});
    if (weak<3) assert.ok(issue.fields.includes((['item','result','unit'] as const)[weak]));
    else {
      assert.deepEqual(issue.fields,[]);
      assert.equal(issue.referenceConfidence,.1);
      assert.equal(row.localObservations[0].referenceLow,null);
      assert.equal(row.localObservations[0].referenceHigh,null);
      assert.equal(row.localObservations[0].referenceText,'0-40');
      assert.equal(row.localObservations[0].unit,'U/L');
    }
  }
}));

test('unparsed suspicious values still expose field confidence for AI response admission', () => withPlanner(() => {
  const raw = ['合成测定项目','O.12','U/L','0-40'].map((text,index)=>({id:`raw-${index}`,text,
    box:[index*200,50,index*200+150,70],confidence:index===1?.2:.99}));
  const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  const row=page.lines[0];
  assert.equal(row.candidate,true);
  assert.equal(row.tableStructureUnsafe,true);
  assert.equal(row.localObservations.length,0);
  assert.deepEqual(observationFieldConfidenceIssue(row,{itemName:'合成测定项目',resultText:'0.12',unit:'U/L'}).fields,['result']);
  assert.match(row.text,/O\.12/,'the uncertain OCR token remains unchanged');
  for (const [name,value] of [['姓名','O.12'],['合成测定项目','OI.12'],['设备型号','CAL8000'],['合成测定项目','O']]) {
    const [negative] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify([
      {id:'name',text:name,box:[0,50,150,70]}, {id:'value',text:value,box:[200,50,300,70]},
    ])}]);
    assert.ok(negative.lines.every(line=>!line.tableStructureUnsafe),`${name} ${value}`);
  }
}));

test('synthetic body-composition and bone-score layouts retain confidence for each original value', () => withPlanner(() => {
  const cases = [
    [
      {id:'heading',text:'人体成分分析报告',box:[0,0,250,20]},
      {id:'name',text:'身高',box:[300,80,380,100]},
      {id:'value',text:'170cm',box:[300,50,380,70]},
    ],
    [
      {id:'heading',text:'超声骨密度检测报告',box:[0,0,250,20]},
      {id:'name',text:'T值',box:[0,40,50,60]},
      {id:'other-name',text:'Z值',box:[200,40,250,60]},
      {id:'value',text:'-1.9',box:[100,120,150,140]},
      {id:'other-value',text:'-1.7',box:[100,155,150,175]},
      {id:'footer',text:'结果分析',box:[0,205,100,225]},
    ],
  ];
  for (const raw of cases) for (const weak of [false,true]) {
    const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw.map(line=>({
      ...line,confidence:weak && line.id==='value'?.45:.99,
    })))}]);
    const row=page.lines.find(line=>line.id.startsWith('body_composition_layout_') || line.id.startsWith('quantitative_ultrasound_bone_layout_'))!;
    assert.ok(row);
    assert.ok((row.confidence || 0)>.65,'the former row mean would have admitted this value');
    assert.equal(row.sourceCells.find(cell=>cell.sourceLineIds.includes('value'))?.confidence,weak?.45:.99);
    assert.equal(row.localObservations.length,weak?0:raw.length===3?1:2);
    if (weak) {
      assert.ok(row.lowConfidenceFields?.includes('result'));
      assert.ok(row.localObservationCandidates?.length);
    }
  }
}));

test('name review proposes only one confusable character against a unique installed trusted identity', () => withPlanner(() => {
  const suggested = trustedOcrNameReviewCandidate('Y-谷氨酰转肽酶');
  assert.ok(suggested);
  assert.equal(suggested.originalName,'Y-谷氨酰转肽酶');
  assert.equal(suggested.suggestedName,'γ-谷氨酰转肽酶');
  for (const name of ['γ-谷氨酰转肽酶','Y-谷氨酰转移酶','超敏C反应蛋白','C反应蛋白','CAI9-9','Y-合成检测项目']) {
    assert.equal(trustedOcrNameReviewCandidate(name),null,name);
  }
  const raw=coordinatePanel('name',0,0,[['项目名称','结果','单位'],['Y-谷氨酰转肽酶','36.7','U/L']]);
  const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  const row=page.lines.find(line=>line.candidate)!;
  assert.equal(row.localObservations.length,0);
  assert.equal(row.nameReviewCandidate?.canonicalKey,suggested.canonicalKey);
  assert.match(row.text,/Y-谷氨酰/);
  const db=getDatabase();
  const other=db.prepare("SELECT id FROM indicator_catalog WHERE canonical_key='liver_alt'").get() as {id:string};
  db.prepare("INSERT INTO indicator_aliases(id,indicator_id,alias_name,normalized_alias,scope,source,confidence,enabled) VALUES('synthetic-confusable',?,'γ-谷氨酰转肽酶','γ谷氨酰转肽酶','global','user',1,1)").run(other.id);
  assert.equal(trustedOcrNameReviewCandidate('Y-谷氨酰转肽酶'),null,'ambiguous dictionary identities never suggest a replacement');
}));

test('mixed categorical rows keep their empty unit and printed reference while hint columns retain arrows', () => withPlanner(() => {
  const raw=coordinatePanel('mixed',0,0,[
    ['项目名称','结果','提示','单位','参考范围'],
    ['尿蛋白','阴性','','','阴性'],
    ['ALT','95','↑','U/L','10-90'],
    ['AST','5','↓','U/L','10-90'],
  ]);
  const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  const facts=page.lines.flatMap(line=>line.localObservations);
  const categorical=facts.find(fact=>fact.itemName==='尿蛋白')!;
  assert.equal(categorical.unit,null);
  assert.equal(categorical.referenceText,'阴性');
  assert.equal(categorical.sourceMap.unit,undefined);
  assert.deepEqual(categorical.sourceMap.reference?.sourceLineIds,['mixed-1-4']);
  assert.equal(facts.find(fact=>fact.itemName==='ALT')?.abnormalFlag,'high');
  assert.equal(facts.find(fact=>fact.itemName==='AST')?.abnormalFlag,'low');
}));

test('recovers a wrapped name before header recovery with realistic overlapping OCR boxes', () => withPlanner(() => {
  const headers = ['项目名称','结果','单位','参考范围'].map((text, column) => ({
    id:`header-${column}`, text, confidence:.99, box:[[78,218],[858,932],[1128,1204],[1399,1537]][column].flatMap((x, i) => [x, i ? 101 : 58]),
  }));
  const data = [
    {id:'name-a',text:'丙氨酸氨基',confidence:.99,box:[81,151,250,185]},
    {id:'result',text:'12.5',confidence:.99,box:[856,145,932,187]},
    {id:'unit',text:'U/L',confidence:.99,box:[1126,145,1190,187]},
    {id:'reference',text:'0-99',confidence:.99,box:[1395,147,1473,186]},
    {id:'name-b',text:'转移酶',confidence:.99,box:[79,184,185,223]},
  ];
  const rebuild = (raw: typeof data) => rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify([...headers,...raw])}])[0];
  const row = rebuild(data).lines.find(line => line.localObservations.length)!;
  assert.equal(row.localObservations[0].itemName,'丙氨酸氨基转移酶');
  assert.equal(row.localObservations[0].numericValue,12.5);
  assert.deepEqual(row.sourceCells[0].sourceLineIds,['name-a','name-b']);
  const separate = rebuild(data.map(line => line.id === 'name-a' ? {...line,text:'ALT'}
    : line.id === 'name-b' ? {...line,text:'AST'} : line));
  assert.ok(separate.lines.every(line => !line.sourceCells.some(cell => cell.sourceLineIds.includes('name-a') && cell.sourceLineIds.includes('name-b'))));
  const ambiguous = rebuild([...data,{id:'second-result',text:'24.6',confidence:.99,box:[856,184,932,223]}]);
  assert.ok(ambiguous.lines.every(line => !line.localObservations.some(item => item.itemName === '丙氨酸氨基转移酶')));
}));

test('unaltered continuation columns reuse the original page header while shifts and weak result cells stay for review', () => withPlanner(() => {
  const first = coordinatePanel('first',0,0,[['项目名称','结果','单位','参考范围'],['合成项目甲','12','U/L','0-30']]);
  for (const variant of ['aligned','shifted','weak'] as const) {
    const second = coordinatePanel('second',0,0,[['合成项目乙','24','U/L','0-30']]).map((line,index) => ({...line,
      tableUnsafe:false,
      confidence:variant === 'weak' && index === 1 ? .1 : .99,
      box:line.box.map((value,axis) => value + (variant === 'shifted' && axis % 2 === 0 ? 90 : 0)),
    }));
    const [, page] = rebuildOcrPages([
      {pageId:'first',pageNumber:1,linesJson:JSON.stringify(first)},
      {pageId:'second',pageNumber:2,linesJson:JSON.stringify(second)},
    ]);
    const row = page.lines.find(line => line.candidate)!;
    assert.ok(row);
    assert.equal(row.localObservations.length,variant === 'aligned' ? 1 : 0,variant);
    assert.equal(row.tableHeaderSourcePageNumber,1);
    assert.deepEqual(row.tableHeaderSourceLineIds,['first-0-0','first-0-1','first-0-2','first-0-3']);
    if (variant === 'aligned') assert.equal(row.localObservations[0].itemName,'合成项目乙');
    if (variant === 'weak') assert.equal(row.tableStructureUnsafe,true);
  }
}));

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

test('coverage notices unprocessed result cells without treating reference values as results', () => {
  const raw = fixture();
  assert.deepEqual(uncoveredOcrResultIds(raw,new Set()),['1-2','2-2']);
  assert.deepEqual(uncoveredOcrResultIds(raw,new Set(['1-2','2-2'])),[]);
});

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

test('fits tilted header baselines before selecting columns, with signed slopes and shuffled OCR', () => withPlanner(() => {
  for (const slope of [.07, -.07, .14, -.14]) {
    const raw = coordinatePanel('tilted', 0, 100, [
      ['项目名称', '结果', '参考值', '单位'],
      ['合成项目甲', '12.5', '0-99', 'U/L'],
      ['合成项目乙', '24', '0-99', 'U/L'],
    ], slope).reverse();
    const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
    const facts = page.lines.flatMap(line => line.localObservations);
    assert.deepEqual(facts.map(f => f.numericValue).sort((a,b)=>Number(a)-Number(b)), [12.5,24]);
    assert.ok(facts.every(f=>f.sourceMap.result.sourceLineIds.length===1));
  }
}));

test('supports explicit two-column, English and OCR-variant headers without requiring dictionary membership', () => withPlanner(() => {
  for (const headers of [['项目名称','结果'],['Test','Result','Reference range','Unit'],['项目名称','结杲','参考范国','单位']]) {
    const raw = coordinatePanel('headers',0,0,[headers,['合成项目甲','12.5','0-99','U/L'].slice(0,headers.length)]);
    const original = JSON.stringify(raw);
    const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:original}]);
    const facts = page.lines.flatMap(l=>l.localObservations);
    assert.equal(facts.length,1,headers.join(','));
    assert.equal(facts[0].numericValue,12.5);
    assert.deepEqual(facts[0].sourceMap.result.sourceLineIds,['headers-1-1']);
    assert.equal(JSON.stringify(raw),original);
  }
}));

test('model table cells and geometric recovery both retain low-confidence measurement fields for review', () => withPlanner(() => {
  for (const model of [false, true]) for (const lowColumn of [0, 1, 2, 3]) {
    const raw = coordinatePanel('confidence', 0, 0, [
      ['项目名称', '结果', '参考值', '单位'], ['合成项目甲', '12.5', '0-99', 'U/L'],
    ]).map(line => ({ ...line, tableUnsafe: false,
      confidence: line.id === `confidence-1-${lowColumn}` ? .1 : .99,
      ...(model ? {tableCell:{table:'table_0', row:Number(line.id.split('-')[1]),column:Number(line.id.split('-')[2]),columns:4}} : {}),
    }));
    const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
    const row = page.lines.find(line => line.sourceLineIds.includes('confidence-1-1'))!;
    assert.ok(row.confidence! > .65, 'the aggregate score alone is insufficient');
    assert.equal(row.sourceCells[lowColumn].confidence, .1);
    assert.equal(row.localObservations.length, lowColumn === 2 ? 1 : 0, `model=${model}, column=${lowColumn}`);
    assert.equal(row.tableStructureUnsafe, lowColumn !== 2);
    assert.equal(row.candidate, true);
  }
}));

test('joins vertically wrapped header tokens while retaining both original source IDs', () => withPlanner(() => {
  const raw = coordinatePanel('wrapped-header',0,0,[
    ['项目名称','结果','参考','单位'],['合成项目甲','12.5','0-99','U/L'],
  ]);
  raw.push({id:'reference-second',text:'范围',confidence:.99,tableUnsafe:true,box:[310,23,400,43]});
  // Keep the data row below the complete two-line heading.
  for (const line of raw.filter(line=>line.id.startsWith('wrapped-header-1'))) line.box=line.box.map((v,i)=>i%2?v+35:v);
  const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  const fact=page.lines.flatMap(line=>line.localObservations)[0];
  assert.equal(fact?.numericValue,12.5);
  assert.ok(fact.sourceMap.reference?.headerSourceLineIds?.includes('reference-second'));
}));

test('recovers failed rows inside a partially mapped model table without changing trusted cells', () => withPlanner(() => {
  const raw = coordinatePanel('partial', 0, 0, [
    ['项目名称', '结果', '参考值', '单位'],
    ['合成项目甲', '12.5', '0-99', 'U/L'],
    ['合成项目乙', '24', '0-99', 'U/L'],
  ]).map(line => Number(line.id.split('-')[1]) < 2 ? {...line, tableUnsafe:false,
    tableCell:{table:'table_0',row:Number(line.id.split('-')[1]),column:Number(line.id.split('-')[2]),columns:4}} : line);
  const recovered = recoverHeaderAlignedTable(raw);
  for (const line of raw.filter(line=>!line.tableUnsafe)) assert.deepEqual(recovered.find(item=>item.id===line.id),line);
  const [page] = rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
  assert.deepEqual(page.lines.flatMap(line=>line.localObservations).map(f=>f.numericValue),[12.5,24]);
}));

test('partial table recovery preserves standalone section headings', () => {
  const raw = coordinatePanel('sections', 0, 0, [
    ['项目名称', '结果', '参考值'], ['合成项目甲', '12.5', '0-99'], ['内科检查'],
  ]).map(line => line.id.startsWith('sections-0') ? {...line, tableUnsafe:false,
    tableCell:{table:'table_0',row:0,column:Number(line.id.split('-')[2]),columns:3}} : line);
  const heading = recoverHeaderAlignedTable(raw).find(line=>line.id==='sections-2-0');
  assert.equal(heading && 'tableCell' in heading, false);
});

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

test('visible headers repair a headerless model with an extra column and overlapping retries', () => withPlanner(() => {
  const headers=['项目','结果','参考区间','单位','检测方法'];
  const positions=[0,300,500,700,900];
  const raw=headers.map((text,i)=>({id:`head-${i}`,text,box:[positions[i],0,positions[i]+90,20],confidence:.99}));
  const cells=['8*★合成指标[SYN]','18. 25','0-30','mmo1/L','酶法'];
  const body=cells.map((text,i)=>({id:`cell-${i}`,text,box:[positions[i],50,positions[i]+150,70],confidence:.98,
    tableCell:{table:'table_0',row:1,column:i<2?i:i+1,columns:6}}));
  const retry={...body[1],id:'retry',text:'18.25',box:[301,51,449,69],confidence:.99};
  const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify([...raw,...body,retry])}]);
  const facts=page.lines.flatMap(l=>l.localObservations);
  assert.equal(facts.length,1);
  assert.equal(facts[0].numericValue,18.25);
  assert.equal(facts[0].unit,'mmol/L');
  assert.equal(facts[0].referenceLow,0);
  assert.equal(facts[0].referenceHigh,30);
}));

test('explicit unit cells retain full tokens rather than matching smaller units inside them', () => withPlanner(() => {
  for (const unit of ['ug/mL','μmo1/L','mmol/L','custom/L','ng/mlL']) {
    const raw=[['项目','结果','参考区间','单位'],['合成指标','12','0-30',unit]].flatMap((cells,row)=>cells.map((text,i)=>({
      id:`${row}-${i}`,text,box:[i*220,row*60,i*220+120,row*60+20],confidence:.99,
    })));
    const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
    const facts=page.lines.flatMap(l=>l.localObservations);
    assert.equal(facts.length,1);
    assert.equal(facts[0].unit,unit.replace('mo1','mol').replace('/mlL','/mL'));
  }
}));

test('a closed code followed by a result can share one box across explicit name and result columns', () => withPlanner(() => {
  for (const token of ['合成项目[SYN]18.25','合成项目[SYN]18.25 19','合成项目18.25']) {
    const raw=[
      {id:'h0',text:'项目',box:[0,0,90,20]}, {id:'h1',text:'结果',box:[300,0,360,20]},
      {id:'h2',text:'参考区间',box:[500,0,580,20]}, {id:'h3',text:'单位',box:[700,0,760,20]},
      {id:'name',text:token,box:[0,50,380,70]}, {id:'ref',text:'1.0 30.0',box:[500,50,580,70]},
      {id:'unit',text:'U/L',box:[700,50,760,70]},
    ].map(line=>({...line,confidence:.99}));
    const [page]=rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}]);
    const facts=page.lines.flatMap(l=>l.localObservations);
    assert.equal(facts.length,token==='合成项目[SYN]18.25'?1:0);
    if(facts.length) {
      assert.equal(facts[0].numericValue,18.25);
      assert.equal(facts[0].referenceLow,1);
      assert.equal(facts[0].referenceHigh,30);
      assert.deepEqual(facts[0].sourceMap.result.sourceLineIds,['name']);
    }
  }
}));


test('two to four wrapped name lines retain every source without merging competing results', () => withPlanner(() => {
  for (const parts of [['25羟基维生','素D'], ['小而密低密','度脂蛋白胆','固醇'], ['合成长','名称检测','项目延续','末段']]) {
    for (const withHeader of [false,true]) {
      const headers = withHeader ? ['项目名称','结果','参考范围','单位'].map((text,i)=>({
        id:`head-${i}`,text,confidence:.99,box:[i*250,0,i*250+120,25],
      })) : [];
      const names=parts.map((text,i)=>({id:`part-${i}`,text,confidence:.99,box:[0,80+i*30,120,105+i*30]}));
      const middle=80+Math.floor(parts.length/2)*30;
      const unit=parts.length===2?'ng/mL':'mmol/L';
      const fields=(withHeader?['18.2','0-99',unit]:['18.2',unit,'0-99']).map((text,i)=>({id:`field-${i}`,text,confidence:.99,box:[(i+1)*250,middle,(i+1)*250+100,middle+25]}));
      const rebuild=(raw:typeof names)=>rebuildOcrPages([{pageId:'synthetic',pageNumber:1,linesJson:JSON.stringify(raw)}])[0];
      const page=rebuild([...headers,...names,...fields]);
      const row=page.lines.find(line=>line.sourceCells.some(cell=>cell.text===parts.join('')));
      assert.ok(row,`${parts.length} lines, header ${withHeader}`);
      assert.equal(row.candidate,true);
      assert.deepEqual(row.sourceCells.find(cell=>cell.text===parts.join(''))?.sourceLineIds,names.map(line=>line.id));
      assert.ok(row.sourceCells.some(cell=>cell.text==='18.2'));
      const competing=rebuild([...headers,...names,...fields,{id:'competing',text:'27.4',confidence:.99,box:[250,80,350,105]}]);
      assert.ok(competing.lines.every(line=>line.sourceCells.every(cell=>cell.text!==parts.join(''))));
    }
  }
}));
