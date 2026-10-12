import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import { applyObservationFieldOverrides, updateManualObservation, deleteManualObservation } from '../services/observation-field-overrides.service';
import { normalizeAiExtraction, persistAiExtraction } from '../services/ai-extraction.service';
import { assessTrendAdmission, assessPersistedObservationReference } from '../services/indicator-normalization.service';
import { rebuildOcrPages } from '../services/ai-input-planner.service';
import { updateClinicalFact, deleteClinicalFact } from '../services/clinical-fact.service';
import { updateReportFields, listTrendSeries, getReportDetail } from '../services/records.service';

function fixture(run: (db: ReturnType<typeof getDatabase>) => void) {
  const previous = process.env.STORAGE_DIR;
  const root = mkdtempSync(join(tmpdir(), 'review-regression-'));
  process.env.STORAGE_DIR = root;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES('owner','合成用户');
      INSERT INTO health_members(id,display_name,created_by) VALUES('m','合成成员','owner');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('m','owner','manager','owner');
      INSERT INTO reports(id,member_id,created_by,report_type,title,status) VALUES('r','m','owner','laboratory','合成报告','ready');
      INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256)
      VALUES('p','r',1,'synthetic.png','synthetic.png','image/png',1,'synthetic');`);
    run(db);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
const user = {id:'owner', displayName:'合成用户', provider:'local', authenticated:true, isGatewayAdmin:false} as const;
const fields = {sectionName:null,itemCode:null,itemName:'合成项目甲',resultText:'12',numericValue:12,unit:'U/L',referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null};
const before = {...fields,normalizedName:null,method:null,evidence:[{pageNumber:1,quote:'合成项目甲 12 U/L'}]};
const reformatted = {...before,evidence:[{pageNumber:1,quote:'合成项目甲 | 12 | U/L'}]};

test('manual edits without a standard do not match distribution widths to cell counts', () => fixture(db => {
  db.exec("UPDATE reports SET report_issued_at='2026-01-01' WHERE id='r'");
  for (const [index, itemName, unit, itemCode] of [
    [0, 'RBC分布宽度CV', '%', null],
    [1, 'RBC分布宽度SD', 'fL', 'RBC'],
    [2, 'PLT分布宽度', 'fL', 'PLT']
  ] as const) {
    const id = `width-${index}`;
    db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit) VALUES(?,?,?,?,?,?)')
      .run(id,'r',itemName,'18',18,unit);
    updateManualObservation(user,'r',id,{...fields,itemName,itemCode,unit,resultText:'18',numericValue:18,canonicalKey:''});
    const saved = getReportDetail(user,'r').observations.find(item => item.id === id)!;
    assert.equal(saved.canonicalKey,null);
    assert.equal(saved.displayTier,'primary');
    assert.doesNotMatch(saved.displayReason || '',/单位.*不兼容/);
  }
  updateManualObservation(user,'r','width-0',{...fields,itemName:'红细胞分布宽度变异系数',unit:'%',canonicalKey:''});
  const standard = getReportDetail(user,'r').observations.find(item => item.id === 'width-0')!;
  assert.equal(standard.canonicalKey,'cbc_rdw_cv');
  assert.equal(standard.displayTier,'primary');
  // Genuine conflicts remain pending with either automatic or manual matching.
  for (const canonicalKey of ['', 'cbc_rbc']) {
    updateManualObservation(user,'r','width-0',{...fields,itemName:'红细胞计数',unit:'%',canonicalKey});
    const conflict = getReportDetail(user,'r').observations.find(item => item.id === 'width-0')!;
    assert.notEqual(conflict.displayTier,'primary');
    assert.match(conflict.displayReason || '',/单位.*不兼容/);
  }
}));

test('stale report metadata forms cannot overwrite a completed edit', () => fixture(db => {
  const version = () => (db.prepare('SELECT source_version AS version FROM reports WHERE id=?').get('r') as {version:number}).version;
  const initial = version();
  updateReportFields(user,'r',{title:'合成报告',reportType:'laboratory',hospitalName:'合成机构甲',expectedSourceVersion:initial});
  const savedVersion = version();
  assert.throws(() => updateReportFields(user,'r',{title:'修改标题',reportType:'laboratory',hospitalName:'旧机构',expectedSourceVersion:initial}), (error: {statusCode?:number}) => error.statusCode === 409);
  assert.equal(version(),savedVersion);
  assert.equal((db.prepare('SELECT hospital_name_raw AS name FROM reports WHERE id=?').get('r') as {name:string}).name,'合成机构甲');
  updateReportFields(user,'r',{title:'修改标题',reportType:'laboratory',hospitalName:'合成机构甲',expectedSourceVersion:savedVersion});
  assert.equal(version(),savedVersion + 1);
}));

test('re-OCR keeps manual changes bound to their source and deletion survives formatting changes', () => fixture(db => {
  db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,?,?,?,?,?,?)')
    .run('o','r',fields.itemName,'12',12,'U/L',JSON.stringify(before.evidence));
  const version = () => (db.prepare('SELECT source_version AS version FROM reports WHERE id=?').get('r') as {version:number}).version;
  const initial = version();
  updateManualObservation(user,'r','o',{...fields,resultText:'13',numericValue:13,expectedSourceVersion:initial});
  assert.throws(() => updateManualObservation(user,'r','o',{...fields,unit:'mU/L',expectedSourceVersion:initial}), /报告已更新/);
  assert.equal((db.prepare('SELECT result_text FROM observations WHERE id=?').get('o') as {result_text:string}).result_text,'13');
  for (const incoming of [reformatted]) {
    const applied = applyObservationFieldOverrides('r',[incoming]);
    assert.equal(applied.length,1);
    assert.equal(applied[0].observation.resultText,'13');
    assert.deepEqual(applied[0].observation.evidence,incoming.evidence);
  }
  const retained = applyObservationFieldOverrides('r',[]);
  assert.equal(retained.length,1);
  assert.deepEqual(retained[0].observation.evidence,[{...before.evidence[0],pageId:'p'}]);
  db.prepare('UPDATE report_pages SET page_number=2 WHERE id=?').run('p');
  const reordered = applyObservationFieldOverrides('r',[{...reformatted,evidence:[{...reformatted.evidence[0],pageNumber:2}]}]);
  assert.equal(reordered.length,1);
  assert.equal(reordered[0].observation.resultText,'13');
  db.prepare('UPDATE report_pages SET page_number=1 WHERE id=?').run('p');
  deleteManualObservation(user,'r','o');
  assert.equal(applyObservationFieldOverrides('r',[reformatted]).length,0);
  assert.equal(applyObservationFieldOverrides('r',[{...reformatted,itemName:'合成另一项目'}]).length,1);
  assert.equal(applyObservationFieldOverrides('r',[{...reformatted,unit:'mU/L'}]).length,1);
  assert.equal(applyObservationFieldOverrides('r',[{...reformatted,evidence:[{pageNumber:2,quote:reformatted.evidence[0].quote}]}]).length,1);
}));

test('a manual correction cannot replace another item from a shared source quote', () => fixture(db => {
  const evidence = [{pageNumber:1,quote:'合成项目甲 12 U/L | 合成项目乙 7 U/L'}];
  db.prepare('INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,?,?,?,?,?,?)')
    .run('o','r',fields.itemName,'12',12,'U/L',JSON.stringify(evidence));
  updateManualObservation(user,'r','o',{...fields,resultText:'13',numericValue:13});
  const incoming = {...before,itemName:'合成项目乙',resultText:'7',numericValue:7,evidence};
  const applied = applyObservationFieldOverrides('r',[incoming]);
  assert.equal(applied.length,2);
  assert.equal(applied.find(item => item.observation.itemName === '合成项目乙')?.observation.numericValue,7);
  assert.equal(applied.find(item => item.observation.itemName === fields.itemName)?.observation.numericValue,13);
  assert.equal(applyObservationFieldOverrides('r',[{...before,evidence},incoming]).length,2);
  db.exec(`INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ai','r','ai_extract','processing','test','ai');`);
  db.exec(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ocr','r','p','ocr','completed','test','ocr');`);
  db.prepare('INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)')
    .run('ocr-result','ocr','p','test','test',JSON.stringify([{id:'line',text:evidence[0].quote,confidence:1,box:[[0,0],[300,0],[300,20],[0,20]]}]));
  persistAiExtraction('r','ai',{...normalizeAiExtraction({observations:[incoming]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0},20);
  const saved = db.prepare('SELECT item_name AS name,numeric_value AS value FROM observations WHERE report_id=? ORDER BY item_name').all('r');
  assert.deepEqual(saved.map(row => ({...row})),[{name:'合成项目乙',value:7},{name:'合成项目甲',value:13}]);
}));

for (const sharedQuote of [false,true]) test(`medication correction and deletion preserve another regimen (shared quote: ${sharedQuote})`, () => fixture(db => {
  db.exec('DELETE FROM report_pages;');
  const medications = [
    {context:'prescription',medicationName:'合成药品甲',dose:'5',doseUnit:'mg',frequency:'早',p:1,q:'合成药品甲 5 mg 早'},
    {context:'prescription',medicationName:'合成药品甲',dose:'10',doseUnit:'mg',frequency:'晚',p:1,q:'合成药品甲 10 mg 晚'},
  ];
  if (sharedQuote) medications.forEach(item => item.q = '合成药品甲 5 mg 早 | 合成药品甲 10 mg 晚');
  const result = {...normalizeAiExtraction({reportType:'prescription',medications}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0};
  let run = 0;
  const rerun = () => {
    const jobId = `ai-${++run}`;
    db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,'r','ai_extract','processing','test',?)").run(jobId,jobId);
    persistAiExtraction('r',jobId,result,20);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM report_extractions WHERE report_id=?').get('r') as {n:number}).n,run);
    return (db.prepare("SELECT id FROM report_medications WHERE dose='10' AND is_deleted=0").get() as {id:string}).id;
  };
  const originalOtherId = rerun();
  const id = (db.prepare("SELECT id FROM report_medications WHERE dose='5'").get() as {id:string}).id;
  updateClinicalFact(user,'medication',id,{dose:'6'});
  updateClinicalFact(user,'medication',id,{dose:'7'});
  const secondOtherId = rerun();
  assert.notEqual(secondOtherId,originalOtherId,'a new AI run must replace the unprotected regimen');
  const active = () => db.prepare('SELECT dose FROM report_medications WHERE is_deleted=0 ORDER BY CAST(dose AS REAL)').all().map(row => row.dose);
  assert.deepEqual(active(),['7','10']);
  deleteClinicalFact(user,'medication',id);
  assert.notEqual(rerun(),secondOtherId,'deletion protection must execute in a new AI job');
  assert.deepEqual(active(),['10']);
}));

test('persistence retains visual regions and image-only measurements stay pending until manual review', () => fixture(db => {
  db.exec(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ocr','r','p','ocr','completed','test','ocr'),('ai','r',NULL,'ai_extract','processing','test','ai');`);
  db.prepare('INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)')
    .run('ocr-result','ocr','p','test','test',JSON.stringify([{id:'line',text:before.evidence[0].quote,confidence:1,box:[[0,0],[300,0],[300,20],[0,20]]}]));
  const region = {candidateId:'line',sourceLineIds:['line'],box:[[0,0],[300,0],[300,20],[0,20]]};
  const result = {...normalizeAiExtraction({observations:[
    {...before,evidence:[{...before.evidence[0],source:'vision',visionRegion:region}]},
    {...before,itemName:'合成项目乙',resultText:'7',numericValue:7,evidence:[{pageNumber:1,quote:'合成项目乙 7 U/L',source:'vision',imageOnly:true}]},
  ]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0};
  persistAiExtraction('r','ai',result,20);
  const saved = db.prepare('SELECT id,item_name AS itemName,result_text AS resultText,numeric_value AS numericValue,unit,evidence_json AS evidenceJson FROM observations WHERE report_id=? ORDER BY item_name').all('r') as Array<{id:string;itemName:string;resultText:string;numericValue:number;unit:string;evidenceJson:string}>;
  assert.equal(saved.length,2);
  assert.deepEqual(JSON.parse(saved.find(item => item.itemName === fields.itemName)!.evidenceJson)[0].visionRegion,region);
  const imageOnly = saved.find(item => item.itemName !== fields.itemName)!;
  assert.equal(JSON.parse(imageOnly.evidenceJson)[0].imageOnly,true);
  const candidate = {...imageOnly, reportId:'r', normalizationMatchedBy:'none',hasAiExtraction:1,reportIssuedAt:'2026-01-01'};
  assert.equal(assessTrendAdmission(candidate).eligible,false);
  assert.equal(assessTrendAdmission({...candidate,manualReviewed:true}).eligible,true);
  assert.equal(getReportDetail(user,'r').observations.find(item => item.id === imageOnly.id)?.requiresVisualReview,true);
  updateManualObservation(user,'r',imageOnly.id,{...fields,...imageOnly});
  assert.equal(getReportDetail(user,'r').observations.find(item => item.id === imageOnly.id)?.requiresVisualReview,false);
}));

test('interval and swapped-side measurements remain visible but never publish a trend point', () => fixture(db => {
  db.exec(`DELETE FROM report_pages;
    UPDATE reports SET report_issued_at='2026-01-01' WHERE id='r';
    INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ai','r','ai_extract','processing','test','ai');`);
  const result = {...normalizeAiExtraction({reportType:'laboratory',observations:[
    {...fields,itemName:'丙氨酸氨基转移酶',itemCode:'ALT',resultText:'1-3',numericValue:1,p:1,q:'ALT 1-3 U/L'},
    {...fields,itemName:'右侧踝肱指数',itemCode:'ABI',resultText:'1.08',numericValue:1.08,unit:null,p:1,q:'ABI 右踝：1.07 | 左踝：1.08'},
  ]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0};
  persistAiExtraction('r','ai',result,20);
  assert.equal(getReportDetail(user,'r').observations.length,2);
  assert.equal(listTrendSeries(user,'m').length,0);
}));

for (const header of [false,true]) for (const weak of ['name','result','reference']) test(`AI persistence preserves field confidence (header ${header}, weak ${weak})`, () => fixture(db => {
  db.exec(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ocr','r','p','ocr','completed','test','ocr'),('ai','r',NULL,'ai_extract','processing','test','ai');`);
  const cell = (id:string,text:string,x:number,y:number,confidence=1) => ({id,text,confidence,box:[[x,y],[x+150,y],[x+150,y+22],[x,y+22]]});
  const lines = [
    ...(header ? [cell('hn','项目',0,0),cell('hv','结果',180,0),cell('hu','单位',360,0),cell('hr','参考范围',540,0)] : []),
    cell('name','丙氨酸氨基转移酶',0,50,weak==='name'?.1:1),cell('result','12',180,50,weak==='result'?.1:1),
    cell('unit','U/L',360,50),cell('reference','0-40',540,50,weak==='reference'?.1:1),
  ];
  db.prepare('INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)')
    .run('ocr-result','ocr','p','test','test',JSON.stringify(lines));
  const planned = rebuildOcrPages([{pageId:'p',pageNumber:1,linesJson:JSON.stringify(lines)}]);
  const quote = planned[0].lines.find(line=>line.text.includes('丙氨酸'))!.text;
  const observation={...before,itemName:'丙氨酸氨基转移酶',referenceLow:0,referenceHigh:40,referenceText:'0-40',evidence:[{pageNumber:1,quote}]};
  persistAiExtraction('r','ai',{...normalizeAiExtraction({observations:[observation]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0},20);
  const saved = db.prepare('SELECT id,item_name AS itemName,result_text AS resultText,numeric_value AS numericValue,unit,reference_low AS referenceLow,reference_high AS referenceHigh,reference_text AS referenceText,evidence_json AS evidenceJson FROM observations WHERE report_id=?').get('r') as unknown as typeof observation & {id:string;evidenceJson:string};
  assert.ok(saved);
  const evidence=JSON.parse(saved.evidenceJson)[0];
  if (weak==='reference') {
    assert.equal(evidence.ocrReferenceConfidence,.1);
    assert.equal(assessPersistedObservationReference({...saved,hasAiExtraction:1}).status,'raw_only');
  } else {
    assert.equal(evidence.ocrLowConfidence,true);
    assert.equal(assessTrendAdmission({...saved,reportId:'r',hasAiExtraction:1,reportIssuedAt:'2026-01-01'}).eligible,false);
    assert.equal(getReportDetail(user,'r').observations.find(item=>item.id===saved.id)?.requiresVisualReview,true);
    updateManualObservation(user,'r',saved.id,{...fields,...saved});
    assert.equal(getReportDetail(user,'r').observations.find(item=>item.id===saved.id)?.requiresVisualReview,false);
  }
}));

test('model-supplied local confidence flags cannot forge local provenance', () => {
  const result=normalizeAiExtraction({observations:[{...before,evidence:[{...before.evidence[0],ocrLowConfidence:true,ocrReferenceConfidence:.1,nameCorrected:true}]}]});
  assert.equal(result.fields.observations[0].evidence[0].ocrLowConfidence,undefined);
  assert.equal(result.fields.observations[0].evidence[0].ocrReferenceConfidence,undefined);
  assert.equal(result.fields.observations[0].evidence[0].nameCorrected,undefined);
});

test('a quote of an original inline cell retains low confidence after row reconstruction', () => fixture(db => {
  db.exec(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ocr','r','p','ocr','completed','test','ocr'),('ai','r',NULL,'ai_extract','processing','test','ai');`);
  const quote='丙氨酸氨基转移酶 12 U/L';
  const lines=[{id:'inline',text:quote,confidence:.2,box:[[0,50],[350,50],[350,72],[0,72]]},
    {id:'reference',text:'参考范围 0-40',confidence:1,box:[[400,50],[600,50],[600,72],[400,72]]}];
  db.prepare('INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)')
    .run('ocr-result','ocr','p','test','test',JSON.stringify(lines));
  const observation={...before,itemName:'丙氨酸氨基转移酶',evidence:[{pageNumber:1,quote}]};
  persistAiExtraction('r','ai',{...normalizeAiExtraction({observations:[observation]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0},20);
  const saved=db.prepare('SELECT evidence_json AS evidence FROM observations WHERE report_id=?').get('r');
  assert.equal(JSON.parse(String(saved?.evidence))[0].ocrLowConfidence,true);
}));

test('duplicate text evidence cannot erase a visual name correction review flag', () => fixture(db => {
  db.exec(`INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key)
    VALUES('ocr','r','p','ocr','completed','test','ocr'),('ai','r',NULL,'ai_extract','processing','test','ai');`);
  const quote=before.evidence[0].quote;
  db.prepare('INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,?,?,?)')
    .run('ocr-result','ocr','p','test','test',JSON.stringify([{id:'line',text:quote,confidence:1,box:[0,0,300,20]}]));
  const observation={...before,evidence:[before.evidence[0],{...before.evidence[0],source:'vision',nameCorrected:true,visionRegion:{candidateId:'line',sourceLineIds:['line'],box:[0,0,300,20]}}]};
  persistAiExtraction('r','ai',{...normalizeAiExtraction({observations:[observation]}),provider:'test',model:'test',promptVersion:'test',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0},20);
  const saved=db.prepare('SELECT id,evidence_json AS evidence FROM observations WHERE report_id=?').get('r');
  assert.equal(JSON.parse(String(saved?.evidence))[0].nameCorrected,true);
  assert.equal(getReportDetail(user,'r').observations[0].requiresVisualReview,true);
  updateManualObservation(user,'r',String(saved?.id),fields);
  assert.equal(getReportDetail(user,'r').observations[0].requiresVisualReview,false);
}));
