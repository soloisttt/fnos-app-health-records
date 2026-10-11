import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/evaluate-ocr-layouts.ts');

test('offline evaluation executes persistence and trend gates without claiming OCR or model execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ocr-evaluation-cli-'));
  try {
    const input = join(directory, 'input.json'), output = join(directory, 'scores.json');
    const cells = [['项目名称','结果','单位','参考范围'],['丙氨酸氨基转移酶','<0.2','U/L','0-40']];
    const lines = cells.flatMap((row,r)=>row.map((text,c)=>({id:`${r}-${c}`,text,confidence:.99,box:[c*350,r*70,c*350+240,r*70+30]})));
    writeFileSync(input,JSON.stringify([{name:'bounded-synthetic',lines,expected:[{name:cells[1][0],value:.2,resultText:'<0.2',unit:'U/L',referenceText:'0-40',pageNumber:1,trendEligible:false}],elapsedMs:0}]));
    const run = spawnSync(process.execPath,['--import','tsx',script,input,output,'--stage=pipeline','--ai=offline'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(run.status,0,run.stderr);
    const [result] = JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.stages.ocr.status,'replayed');
    assert.equal(result.stages.ai.status,'skipped');
    assert.equal(result.stages.ai.modelCalls,0);
    assert.equal(result.stages.ai.visionCalls,0);
    assert.equal(result.stages.persistence.status,'executed');
    assert.equal(result.stages.persistence.score.complete,1);
    assert.equal(result.stages.trend.status,'executed');
    assert.equal(result.stages.trend.score.expected,0);
    assert.equal(result.stages.trend.score.extracted,0);
    assert.equal(result.stages.trend.admission.shouldExclude,1);
    assert.equal(result.stages.trend.admission.excluded,1);
    assert.equal(result.stages.persistence.score.fieldCoverage.referenceLow.status,'not_scored');
    assert.doesNotMatch(run.stdout,/丙氨酸|U\/L|0-40|0\.2/);
    const legacy = spawnSync(process.execPath,['--import','tsx',script,input,output],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(legacy.status,0,legacy.stderr);
    assert.equal(JSON.parse(readFileSync(output,'utf8'))[0].stages.persistence.status,'skipped');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('controlled OCR faults stay labelled and unit conversion is scored against trend expectations', () => {
  const directory=mkdtempSync(join(tmpdir(),'ocr-evaluation-conversion-'));
  try {
    const input=join(directory,'input.json'),output=join(directory,'score.json');
    const cells=[['项目名称','结果','单位','参考范围'],['血红蛋白','12','g/dL','10-16'],['RV5 振幅','2','mv','1-3']];
    const lines=cells.flatMap((row,r)=>row.map((text,c)=>({id:`${r}-${c}`,text,confidence:.99,box:[c*350,r*70,c*350+240,r*70+30]})));
    writeFileSync(input,JSON.stringify([{name:'converted-synthetic',lines,ocr:{status:'modified',engineStatus:'executed',reason:'controlled_ocr_fault_after_engine_execution'},
      expected:[{name:cells[1][0],value:12,resultText:'12',unit:'g/dL',referenceText:'10-16',referenceLow:10,referenceHigh:16,pageNumber:1,trendEligible:true,
        trendExpected:{value:120,unit:'g/L',referenceLow:100,referenceHigh:160,referenceText:null}},
        {name:cells[2][0],value:2,resultText:'2',unit:'mv',referenceText:'1-3',referenceLow:1,referenceHigh:3,pageNumber:1,trendEligible:true,
          trendExpected:{unit:'mV',referenceText:null}}]}]));
    const run=spawnSync(process.execPath,['--import','tsx',script,input,output,'--stage=pipeline'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(run.status,0,run.stderr);
    const [result]=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.stages.ocr.status,'modified');
    assert.equal(result.stages.persistence.score.complete,2);
    assert.equal(result.stages.trend.score.complete,2);
    assert.equal(result.stages.trend.admission.admitted,2);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('live evaluation requires explicit configuration and rejects invalid flags', () => {
  for (const flags of [['--stage=pipeline','--ai=live'], ['--stage=unknown']]) {
    const run = spawnSync(process.execPath,['--import','tsx',script,'unused-input','unused-output',...flags],
      {cwd:root,encoding:'utf8',timeout:10_000,env:{...process.env,OCR_EVAL_AI_CONFIG:''}});
    assert.equal(run.status,1);
    assert.match(run.stderr,/EVALUATION_FAILED/);
  }
});

test('a wrapped name suffix does not move another item source between extraction and persistence scoring', () => {
  const directory=mkdtempSync(join(tmpdir(),'ocr-evaluation-source-'));
  try {
    const input=join(directory,'input.json'), output=join(directory,'score.json');
    const names=['丙氨酸氨基转移酶','天门冬氨酸氨基转移酶'];
    const cells=[['项目名称','结果','单位','参考范围'],['丙氨酸氨基','12','U/L','0-99'],[names[1],'24','U/L','0-99']];
    const lines=cells.flatMap((row,r)=>row.map((text,c)=>({id:`${r}-${c}`,text,confidence:.99,box:[c*350,r*130,c*350+240,r*130+30]})));
    lines.push({id:'wrapped-suffix',text:'转移酶',confidence:.99,box:[0,170,100,200]});
    const expected=names.map((name,index)=>({name,value:index ? 24 : 12,resultText:index ? '24':'12',unit:'U/L',referenceText:'0-99',pageNumber:1,sourceBox:[0,120+index*130,300,220+index*130]}));
    writeFileSync(input,JSON.stringify([{name:'wrapped-source',lines,expected}]));
    const run=spawnSync(process.execPath,['--import','tsx',script,input,output,'--stage=pipeline'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(run.status,0,run.stderr);
    const [result]=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.stages.extraction.score.missing,0);
    assert.equal(result.stages.extraction.score.fieldErrors.value,0);
    assert.equal(result.stages.extraction.score.missing,result.stages.persistence.score.missing);
    assert.equal(result.stages.extraction.score.fieldErrors.value,result.stages.persistence.score.fieldErrors.value);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('unknown measurements across pages require actual scalar extraction and supplement review', () => {
  const directory=mkdtempSync(join(tmpdir(),'ocr-evaluation-required-ai-'));
  try {
    const input=join(directory,'input.json'),output=join(directory,'score.json');
    const expected=['合成检测项甲','合成检测项乙'].map((name,index)=>({name,value:17+index*6,resultText:String(17+index*6),unit:index ? 'mg/L':'U/L',pageNumber:index+1,trendEligible:true}));
    const pages=expected.map((item,index)=>({pageNumber:index+1,lines:[item.name,item.resultText,item.unit].map((text,column)=>({id:`line-${column}`,text,confidence:.99,box:[column*500,130,column*500+300,170]}))}));
    writeFileSync(input,JSON.stringify([{name:'scalar-required',pages,expected}]));
    const run=spawnSync(process.execPath,['--import','tsx',script,input,output,'--stage=pipeline'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(run.status,0,run.stderr);
    const [result]=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.stages.planner.score.extracted,0);
    assert.ok(result.stages.extraction.units.some((unit:{route:string;candidateCount:number})=>unit.route==='scalar'&&unit.candidateCount===2));
    assert.ok(result.stages.extraction.units.some((unit:{unitType:string;candidateCount:number})=>unit.unitType==='supplement'&&unit.candidateCount===2));
    assert.equal(result.stages.ai.status,'skipped');
    assert.equal(result.stages.extraction.score.missing,2);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('exact source quotes anchor short item names consistently before and after persistence', () => {
  const directory=mkdtempSync(join(tmpdir(),'ocr-evaluation-short-names-'));
  try {
    const input=join(directory,'input.json'),output=join(directory,'score.json');
    const cells=[['项目名称','结果','单位','参考范围'],['身高','170','cm','100-200'],['体重','60','kg','40-90']];
    const lines=cells.flatMap((row,r)=>row.map((text,c)=>({id:`${r}-${c}`,text,confidence:.99,box:[c*350,r*70,c*350+240,r*70+30]})));
    const expected=cells.slice(1).map((row,i)=>({name:row[0],value:Number(row[1]),resultText:row[1],unit:row[2],referenceText:row[3],pageNumber:1,sourceBox:[0,(i+1)*70,300,(i+1)*70+40]}));
    writeFileSync(input,JSON.stringify([{name:'short-names',lines,expected}]));
    const run=spawnSync(process.execPath,['--import','tsx',script,input,output,'--stage=pipeline'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(run.status,0,run.stderr);
    const [result]=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.stages.extraction.score.complete,2);
    assert.equal(result.stages.persistence.score.complete,2);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
