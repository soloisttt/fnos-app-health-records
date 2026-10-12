import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { observationForScore, scoreObservations, scoreContribution, scoreTrendAdmission, visionItemSourceIds, type ScoredObservation } from '../../../scripts/ocr-evaluation-score';

const fact: ScoredObservation = { name: 'Synthetic item', value: 12, resultText: '12', unit: 'U/L', referenceText: '0-20', pageNumber: 1 };

test('one extracted occurrence cannot satisfy two expected occurrences', () => {
  const score = scoreObservations([fact, fact], [fact]);
  assert.equal(score.complete, 1);
  assert.equal(score.missing, 1);
  assert.equal(score.correctNameAndValue, 1);
  assert.equal(score.recall, .5);
});

test('separates missing, invented, duplicate and field-error observations', () => {
  const score = scoreObservations([fact, { ...fact, name: 'Missing item' }], [
    { ...fact, unit: 'mg/L', referenceText: '0-30', resultText: '<12' },
    { ...fact, unit: 'mg/L', referenceText: '0-30', resultText: '<12' },
    { ...fact, name: 'Invented item' },
  ]);
  assert.equal(score.missing, 1);
  assert.equal(score.wrong, 1);
  assert.equal(score.duplicate, 1);
  assert.equal(score.fieldErrorItems, 1);
  assert.equal(score.fieldErrors.unit, 1);
  assert.equal(score.fieldErrors.referenceText, 1);
  assert.equal(score.fieldErrors.resultText, 1);
  assert.equal(score.complete, 0);
});

test('matches repeated names by occurrence context without hiding swapped values or pages', () => {
  const expected = [fact, { ...fact, value: 24, resultText: '24', pageNumber: 2 }];
  assert.equal(scoreObservations(expected, [...expected].reverse()).complete, 2);
  const swapped = scoreObservations(expected, [{ ...expected[0], value: 24, resultText: '24' }, { ...expected[1], value: 12, resultText: '12' }]);
  assert.equal(swapped.fieldErrors.value, 2);
  assert.equal(swapped.fieldErrors.pageNumber, 0);
  assert.equal(swapped.missing, 0);
});

test('source anchors diagnose a wrong name as a field error rather than silently matching by value', () => {
  const expected = { ...fact, sourceBox: [0, 0, 200, 40] };
  const actual = { ...fact, name: 'Wrong name', sourceBox: [10, 5, 100, 25] };
  const score = scoreObservations([expected], [actual]);
  assert.equal(score.fieldErrors.name, 1);
  assert.equal(score.fieldErrorItems, 1);
  assert.equal(score.missing, 0);
  assert.equal(score.complete, 0);
  const anotherPage = scoreObservations([expected], [{...actual,pageNumber:2}]);
  assert.equal(anotherPage.missing,1);
  assert.equal(anotherPage.wrong,1);
});

test('duplicate counting preserves separate source occurrences with identical fields', () => {
  for (const [first,second] of [
    [{...fact,occurrenceId:'first'},{...fact,occurrenceId:'second'}],
    [{...fact,sourceLineIds:['first']},{...fact,sourceLineIds:['second']}],
    [{...fact,sourceBox:[0,0,100,30]},{...fact,sourceBox:[0,100,100,130]}],
  ]) {
    const score=scoreObservations([first],[first,second,{...first}]);
    assert.equal(score.duplicate,1);
    assert.equal(score.wrong,1);
    assert.equal(score.complete,1);
  }
});

test('reuses existing planner expected observations without another expected-value fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/p3-cross-line-indicator-continuation-golden.json', import.meta.url), 'utf8'));
  const expected = fixture.expected.observations.map(observationForScore) as ScoredObservation[];
  assert.ok(expected.length > 0 && expected.every(item => item.name && typeof item.value === 'number'));
  assert.equal(scoreObservations(expected, expected).complete, expected.length);
  const omitted = scoreObservations(expected, expected.slice(1));
  assert.equal(omitted.missing, 1);
});

test('aggregated scores contain no source names, results or evidence', () => {
  const score = scoreObservations([fact], [{ ...fact, name: 'private synthetic text' }]);
  assert.doesNotMatch(JSON.stringify(score), /Synthetic|private|U\/L|0-20/);
  assert.equal(score.missing, 1);
  assert.equal(score.wrong, 1);
});

test('field coverage distinguishes untested fields from correct and missing observations', () => {
  const score=scoreObservations([fact,{...fact,name:'Missing',referenceLow:0}], [{...fact,unit:'mg/L'}]);
  assert.deepEqual(score.fieldCoverage.abnormalFlag,{status:'not_scored',expected:0,evaluated:0,missing:0,correct:0,accuracy:null});
  assert.deepEqual(score.fieldCoverage.referenceLow,{status:'scored',expected:1,evaluated:0,missing:1,correct:0,accuracy:0});
  assert.equal(score.fieldCoverage.unit.expected,2);
  assert.equal(score.fieldCoverage.unit.correct,0);
});

test('AI contributions separate correct additions, corrections, losses and regressions', () => {
  const expected=[fact,{...fact,name:'Added'},{...fact,name:'Corrected'},{...fact,name:'Lost'}];
  const local=[fact,{...expected[2],value:99},expected[3]];
  const merged=[{...fact,value:99},expected[1],expected[2],{...fact,name:'Invented'}];
  assert.deepEqual(scoreContribution(expected,local,merged),{added:1,addedCorrect:1,corrected:1,regressed:1,lost:1});
});

test('trend admission independently counts required and prohibited occurrences', () => {
  const expected=[{...fact,trendEligible:true},{...fact,name:'Excluded',trendEligible:false},
    {...fact,name:'Missing required',trendEligible:true},{...fact,name:'Safely excluded',trendEligible:false}];
  const score=scoreTrendAdmission(expected,[expected[0],expected[1],{...fact,name:'Invented'}]);
  assert.deepEqual(score,{shouldAdmit:2,admitted:1,falselyExcluded:1,shouldExclude:2,excluded:1,falselyAdmitted:1,
    unexpected:1,admissionRecall:.5,exclusionAccuracy:.5});
});

test('visual name corrections use the item cell inside a verified candidate row', () => {
  const name='γ-合成项目';
  const line={id:'row-1',sourceLineIds:['name','value','unit'],nameReviewCandidate:{originalName:'Y-合成项目',suggestedName:name,sourceLineIds:['name']}};
  const pages=[{pageNumber:1,lines:[line]}];
  const evidence={pageNumber:1,visionRegion:{candidateId:'row-1',sourceLineIds:['name','value','unit']}};
  const ids=visionItemSourceIds(name,evidence,pages);
  assert.deepEqual(ids,['name']);
  const expected={...fact,name,sourceBox:[0,0,200,40]};
  const rowBox=[0,0,1000,40],itemBox=[10,5,120,35];
  assert.equal(scoreObservations([expected],[{...expected,sourceBox:rowBox}]).fieldErrors.source,1);
  assert.equal(scoreObservations([expected],[{...expected,sourceLineIds:ids,sourceBox:itemBox}]).fieldErrors.source,0);
  assert.deepEqual(visionItemSourceIds(name,{...evidence,pageNumber:2},pages),[]);
  assert.deepEqual(visionItemSourceIds(name,{...evidence,visionRegion:{candidateId:'absent',sourceLineIds:['name']}},pages),[]);
  assert.deepEqual(visionItemSourceIds(name,evidence,[{pageNumber:1,lines:[line,line]}]),[]);
  assert.deepEqual(visionItemSourceIds(name,{...evidence,visionRegion:{candidateId:'row-1',sourceLineIds:['value','unit']}},pages),[]);
});

test('visual item anchors require a unique same-name fact with source IDs inside the region', () => {
  const item={itemName:'Synthetic item',normalizedName:null,sourceMap:{item:{sourceLineIds:['left-name']}}};
  const line={id:'row-1',sourceLineIds:['left-name','right-name','result'],localObservationCandidates:[item]};
  const evidence={pageNumber:1,visionRegion:{candidateId:'row-1',sourceLineIds:line.sourceLineIds}};
  assert.deepEqual(visionItemSourceIds(item.itemName,evidence,[{pageNumber:1,lines:[line]}]),['left-name']);
  assert.deepEqual(visionItemSourceIds('Other item',evidence,[{pageNumber:1,lines:[line]}]),[]);
  assert.deepEqual(visionItemSourceIds(item.itemName,evidence,[{pageNumber:1,lines:[{...line,localObservationCandidates:[item,
    {...item,sourceMap:{item:{sourceLineIds:['right-name']}}}]}]}]),[]);
});
