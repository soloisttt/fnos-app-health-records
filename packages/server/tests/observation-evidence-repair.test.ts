import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getDatabase,closeDatabaseForTests} from '../database/client';
import {repairLegacyObservationUnitEvidence} from '../services/observation-evidence-repair.service';
import {normalizeReportObservations} from '../services/indicator-normalization.service';

test('legacy evidence repair preserves measurements, respects manual edits and does not borrow units',()=>{
 const old=process.env.STORAGE_DIR,dir=mkdtempSync(join(tmpdir(),'unit-evidence-'));
 process.env.STORAGE_DIR=dir;
 try {
  const db=getDatabase();
  db.exec(`INSERT INTO users(id,display_name) VALUES('owner','fixture');
    INSERT INTO health_members(id,display_name,created_by) VALUES('member','fixture','owner');
    INSERT INTO reports(id,member_id,created_by,title,status,report_type) VALUES('report','member','owner','fixture','ready','laboratory');
    INSERT INTO report_pages(id,report_id,page_number,original_name,storage_path,mime_type,file_size,sha256) VALUES('page','report',1,'fixture.png','fixture.png','image/png',1,'fixture');`);
  const xs=[70,285,400,545,630,835,945,1090], raw:any[]=[];
  const add=(row:number,values:string[])=>values.forEach((text,col)=>{if(text)raw.push({id:`r${row}c${col}`,text,confidence:.99,tableUnsafe:true,box:[xs[col]+(row===0&&col%4===0?60:0),row*40,xs[col]+(col%4===0?155:55),row*40+22]});});
  add(0,['名','结果','参考值','单位','名','结果','参考值','单位']);
  add(1,['葡萄糖','5.2','3.9-6.1','mmol/L','甘油三酯','1.2','0.2-1.7','mmol/L']);
  add(2,['葡萄糖','5.4','3.9-6.1','mmol/L','甘油三酯','1.3','0.2-1.7','']);
  db.exec("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES('job','report','ocr','completed','fixture','fixture')");
  add(3,['甘油三酯','1.4','0.2-1.7','mmol/L','甘油三酯','1.4','0.2-1.7','mmol/L']);
  db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES('ocr','job','page','fixture','fixture',?)").run(JSON.stringify(raw));
  const addObservation=(id:string,row:number,result:string,unit:string)=>{
   const evidence=JSON.stringify([{pageNumber:1,pageId:'page',quote:`甘油三酯 | ${result}`,table:{headerText:'名 | 结果 | 参考值 | 单位',headerSourceLineIds:['r0c4','r0c5','r0c6','r0c7'],rowSourceLineIds:Array.from({length:8},(_,i)=>`r${row}c${i}`)}}]);
   db.prepare("INSERT INTO observations(id,report_id,item_name,result_text,numeric_value,unit,evidence_json) VALUES(?,'report','甘油三酯',?,?,?,?)").run(id,result,Number(result),unit,evidence);
  };
  addObservation('good',1,'1.2','mmol/L');addObservation('wrong-unit',1,'1.2','mg/L');addObservation('missing',2,'1.3','mmol/L');
  db.exec("INSERT INTO report_extractions(id,report_id,job_id,provider,model,prompt_version,fields_json,raw_response_json) VALUES('extract','report','job','fixture','fixture','fixture','{}','{}')");
  addObservation('ambiguous',3,'1.4','mmol/L');
  normalizeReportObservations('report');
  addObservation('manual',1,'1.2','mmol/L');
  db.exec("INSERT INTO observation_field_overrides(id,report_id,source_key,observation_id,fields_json) VALUES('override','report','manual','manual','{}')");
  db.exec("INSERT INTO observation_normalizations(observation_id,confidence,quality,matched_by,match_reason,version,excluded_reason) VALUES('manual',0,'low','unmatched','fixture','fixture','结果单位无法回指 OCR 证据，禁止进入默认趋势')");
  const manualBefore=db.prepare("SELECT * FROM observations WHERE id='manual'").get();
  const before=db.prepare("SELECT * FROM observations WHERE id='good'").get()!;
  assert.equal(repairLegacyObservationUnitEvidence('report'),1);
  const after=db.prepare("SELECT * FROM observations WHERE id='good'").get()!;
  assert.deepEqual({...after,evidence_json:before.evidence_json},{...before});
  const evidence=JSON.parse(String(after.evidence_json));
  assert.deepEqual(evidence[0].table.sourceMap.unit.sourceLineIds,['r1c7']);
  assert.equal(repairLegacyObservationUnitEvidence('report'),0);
  assert.deepEqual(db.prepare("SELECT * FROM observations WHERE id='manual'").get(),manualBefore);
  normalizeReportObservations('report');
  assert.equal(db.prepare("SELECT excluded_reason FROM observation_normalizations WHERE observation_id='good'").get()!.excluded_reason,null);
  for(const id of ['wrong-unit','missing','ambiguous']) assert.match(String(db.prepare('SELECT excluded_reason FROM observation_normalizations WHERE observation_id=?').get(id)!.excluded_reason),/单位/);
  db.prepare("UPDATE observations SET evidence_json=? WHERE id='good'").run(before.evidence_json);
  db.exec("UPDATE observation_normalizations SET excluded_reason='结果单位无法回指 OCR 证据，禁止进入默认趋势' WHERE observation_id='good'; CREATE TRIGGER fail_normalization BEFORE UPDATE ON observation_normalizations BEGIN SELECT RAISE(ABORT,'fixture normalization failure'); END");
  assert.throws(()=>normalizeReportObservations('report'),/fixture normalization failure/);
  assert.equal(db.prepare("SELECT evidence_json FROM observations WHERE id='good'").get()!.evidence_json,before.evidence_json);
 } finally {closeDatabaseForTests();if(old===undefined)delete process.env.STORAGE_DIR;else process.env.STORAGE_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
