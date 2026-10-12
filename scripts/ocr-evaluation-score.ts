/** Field scoring shared by the OCR scripts and existing regression goldens.
 * This module returns aggregate counts only, never source text or measurements.
 */
export type ScoredObservation = {
  name: string;
  value: number | null;
  resultText?: string | null;
  unit?: string | null;
  referenceText?: string | null;
  referenceLow?: number | null;
  referenceHigh?: number | null;
  abnormalFlag?: string | null;
  pageNumber?: number | null;
  timeText?: string | null;
  sourceLineIds?: string[];
  sourceBox?: number[];
  occurrenceId?: string;
  trendEligible?: boolean;
  trendExpected?: Partial<ScoredObservation>;
};

const text = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[−–—]/g, '-');
const resultText = (value: unknown) => text(value).replace(/≤/g, '<=').replace(/≥/g, '>=');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Accepts existing fixture expected.observations and planner/AI observation shapes. */
export function observationForScore(input: Record<string, unknown>): ScoredObservation {
  const result: ScoredObservation = {
    name: String(input.name ?? input.itemName ?? input.normalizedName ?? ''),
    value: typeof (input.value ?? input.numericValue) === 'number' ? Number(input.value ?? input.numericValue) : null,
  };
  for (const field of ['resultText', 'unit', 'referenceText', 'referenceLow', 'referenceHigh', 'abnormalFlag', 'pageNumber', 'timeText', 'sourceLineIds', 'sourceBox', 'occurrenceId', 'trendEligible', 'trendExpected'] as const) {
    if (own(input, field)) Object.assign(result, { [field]: input[field] });
  }
  if (!own(result,'unit') && own(input,'sourceUnit')) result.unit=input.sourceUnit as string | null;
  const examination = input.examination as { timeText?: string | null } | undefined;
  if (!own(result, 'timeText') && examination && own(examination, 'timeText')) result.timeText = examination.timeText;
  return result;
}

type ItemSourceFact = {itemName:string;normalizedName?:string|null;sourceMap:{item:{sourceLineIds:string[]}}};
type ItemSourceLine = {
  id:string;sourceLineIds:string[];
  nameReviewCandidate?:{originalName:string;suggestedName:string;sourceLineIds:string[]};
  localObservations?:ItemSourceFact[];localObservationCandidates?:ItemSourceFact[];
};

/** A visual region covers a row; only a uniquely identified item cell is a name anchor. */
export function visionItemSourceIds(name:string, evidence:{pageNumber:number;visionRegion?:{candidateId:string;sourceLineIds:string[]}}|undefined,
  pages:Array<{pageNumber:number;lines:ItemSourceLine[]}>) {
  const region=evidence?.visionRegion;
  if (!evidence || !region?.candidateId || !region.sourceLineIds.length) return [];
  const matchingPages=pages.filter(page=>page.pageNumber===evidence.pageNumber);
  if (matchingPages.length!==1) return [];
  const matchingLines=matchingPages[0].lines.filter(line=>line.id===region.candidateId);
  if (matchingLines.length!==1) return [];
  const line=matchingLines[0];
  if (!region.sourceLineIds.every(id=>line.sourceLineIds.includes(id))) return [];
  const valid=(ids:string[])=>ids.length>0 && ids.every(id=>line.sourceLineIds.includes(id)&&region.sourceLineIds.includes(id));
  const review=line.nameReviewCandidate;
  if (review && [review.originalName,review.suggestedName].some(value=>text(value)===text(name)) && valid(review.sourceLineIds)) return review.sourceLineIds;
  const sources=[...(line.localObservations || []),...(line.localObservationCandidates || [])]
    .filter(fact=>[fact.itemName,fact.normalizedName].some(value=>text(value)===text(name)))
    .map(fact=>fact.sourceMap.item.sourceLineIds).filter(valid);
  const unique=[...new Map(sources.map(ids=>[JSON.stringify([...ids].sort()),ids])).values()];
  return unique.length===1 ? unique[0] : [];
}

const samePage = (a: ScoredObservation, b: ScoredObservation) => a.pageNumber == null || b.pageNumber == null || a.pageNumber === b.pageNumber;
function inside(expected: number[] | undefined, actual: number[] | undefined) {
  if (!expected || !actual || expected.length !== 4 || actual.length !== 4) return false;
  const x = (actual[0] + actual[2]) / 2, y = (actual[1] + actual[3]) / 2;
  return x >= expected[0] && x <= expected[2] && y >= expected[1] && y <= expected[3];
}

function sameOccurrence(a: ScoredObservation, b: ScoredObservation) {
  if (a.occurrenceId && b.occurrenceId) return a.occurrenceId === b.occurrenceId;
  const anchored = (item: ScoredObservation) => Boolean(item.occurrenceId || item.sourceLineIds?.length || item.sourceBox);
  if (!anchored(a) && !anchored(b)) return true;
  return samePage(a,b) && (Boolean(a.sourceLineIds?.some(id=>b.sourceLineIds?.includes(id)))
    || inside(a.sourceBox,b.sourceBox) || inside(b.sourceBox,a.sourceBox));
}
function weight(expected: ScoredObservation, actual: ScoredObservation) {
  const sameName = Boolean(text(expected.name)) && text(expected.name) === text(actual.name);
  const identity = Boolean(expected.occurrenceId && expected.occurrenceId === actual.occurrenceId);
  const sharedSource = samePage(expected, actual) && Boolean(expected.sourceLineIds?.some(id => actual.sourceLineIds?.includes(id)));
  const sourceBox = samePage(expected, actual) && inside(expected.sourceBox, actual.sourceBox);
  if (!sameName && !identity && !sharedSource && !sourceBox) return 0;
  return 1_000 + Number(identity) * 100_000 + Number(sharedSource || sourceBox) * 10_000
    + Number(sameName) * 1_000 + Number(samePage(expected, actual)) * 200
    + Number(!own(expected, 'timeText') || text(expected.timeText) === text(actual.timeText)) * 100
    + Number(expected.value === actual.value) * 20
    + Number(!own(expected, 'resultText') || resultText(expected.resultText) === resultText(actual.resultText)) * 10
    + Number(!own(expected, 'unit') || text(expected.unit) === text(actual.unit));
}

/** Rectangular Hungarian matching. Dummy columns represent missing occurrences. */
function pairs(expected: ScoredObservation[], actual: ScoredObservation[]) {
  const n = expected.length, m = actual.length + n;
  const weights = expected.map(e => actual.map(a => weight(e, a)));
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const min = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cost = -(weights[i0 - 1]?.[j - 1] || 0) - u[i0] - v[j];
        if (cost < min[j]) { min[j] = cost; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else min[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  return p.flatMap((row, column) => row && column > 0 && column <= actual.length && weights[row - 1][column - 1] > 0
    ? [{ expected: row - 1, actual: column - 1 }] : []);
}

const scalarFields = ['name', 'value', 'resultText', 'unit', 'referenceText', 'referenceLow', 'referenceHigh', 'abnormalFlag', 'pageNumber', 'timeText'] as const;
export function scoreObservations(expected: ScoredObservation[], actual: ScoredObservation[]) {
  const matched = pairs(expected, actual);
  const fieldErrors = Object.fromEntries([...scalarFields, 'source'].map(field => [field, 0])) as Record<typeof scalarFields[number] | 'source', number>;
  const hasField = (item: ScoredObservation, field: typeof scalarFields[number] | 'source') => field === 'source'
    ? Boolean(item.occurrenceId || item.sourceLineIds?.length || item.sourceBox) : own(item,field);
  const fieldCoverage = Object.fromEntries([...scalarFields,'source'].map(field => {
    const key=field as typeof scalarFields[number] | 'source';
    const expectedCount=expected.filter(item=>hasField(item,key)).length;
    const evaluated=matched.filter(pair=>hasField(expected[pair.expected],key)).length;
    return [key,{status:expectedCount ? 'scored' : 'not_scored',expected:expectedCount,evaluated,missing:expectedCount-evaluated,
      correct:0,accuracy:null as number|null}];
  }));
  let correctNameAndValue = 0, correctUnit = 0, complete = 0;
  for (const pair of matched) {
    const e = expected[pair.expected], a = actual[pair.actual];
    let errors = 0;
    for (const field of scalarFields) {
      if (!own(e, field)) continue;
      const equal = ['value', 'referenceLow', 'referenceHigh', 'pageNumber'].includes(field)
        ? e[field] === a[field]
        : field === 'resultText' ? resultText(e[field]) === resultText(a[field]) : text(e[field]) === text(a[field]);
      if (!equal) { fieldErrors[field]++; errors++; }
    }
    if ((e.occurrenceId && e.occurrenceId !== a.occurrenceId)
      || (e.sourceLineIds?.length && !e.sourceLineIds.every(id => a.sourceLineIds?.includes(id)))
      || (e.sourceBox && !inside(e.sourceBox, a.sourceBox))) { fieldErrors.source++; errors++; }
    const coreCorrect = text(e.name) === text(a.name) && e.value === a.value;
    correctNameAndValue += Number(coreCorrect);
    correctUnit += Number(coreCorrect && (!own(e, 'unit') || text(e.unit) === text(a.unit)));
    complete += Number(errors === 0);
  }
  const used = new Set(matched.map(pair => pair.actual));
  const extras = actual.filter((_, index) => !used.has(index));
  const identity = (item: ScoredObservation) => JSON.stringify([text(item.name), item.value, resultText(item.resultText), text(item.unit), item.pageNumber ?? null, text(item.timeText)]);
  const seen = matched.map(pair => actual[pair.actual]);
  let duplicate = 0;
  for (const item of extras) {
    if (seen.some(other=>identity(other)===identity(item) && sameOccurrence(other,item))) duplicate++;
    seen.push(item);
  }
  for (const [key,coverage] of Object.entries(fieldCoverage)) {
    coverage.correct=coverage.evaluated-fieldErrors[key as keyof typeof fieldErrors];
    coverage.accuracy=coverage.expected ? coverage.correct/coverage.expected : null;
  }
  return {
    expected: expected.length, extracted: actual.length, matched: matched.length,
    missing: expected.length - matched.length, wrong: extras.length - duplicate, duplicate,
    fieldErrorItems: matched.length - complete, fieldErrors, fieldCoverage,
    correctNameAndValue, correctUnit, complete, falsePositive: extras.length,
    itemRecall: expected.length ? matched.length / expected.length : null,
    itemPrecision: actual.length ? matched.length / actual.length : null,
    // Strict field-level accuracy: every declared expected field must match.
    recall: expected.length ? complete / expected.length : null,
    precision: actual.length ? complete / actual.length : null,
  };
}

/** Counts changes to the same expected occurrences, never credits extra items as improvements. */
export function scoreContribution(expected: ScoredObservation[], local: ScoredObservation[], merged: ScoredObservation[]) {
  const before=new Map(pairs(expected,local).map(pair=>[pair.expected,pair.actual]));
  const after=new Map(pairs(expected,merged).map(pair=>[pair.expected,pair.actual]));
  let added=0,addedCorrect=0,corrected=0,regressed=0,lost=0;
  for (let index=0;index<expected.length;index++) {
    const b=before.get(index),a=after.get(index);
    const beforeCorrect=b!==undefined && scoreObservations([expected[index]],[local[b]]).complete===1;
    const afterCorrect=a!==undefined && scoreObservations([expected[index]],[merged[a]]).complete===1;
    if (b===undefined && a!==undefined) { added++; addedCorrect+=Number(afterCorrect); }
    if (b!==undefined && a===undefined) lost++;
    if (b!==undefined && a!==undefined) { corrected+=Number(!beforeCorrect && afterCorrect); regressed+=Number(beforeCorrect && !afterCorrect); }
  }
  return {added,addedCorrect,corrected,regressed,lost};
}

export function scoreTrendAdmission(expected: ScoredObservation[], actual: ScoredObservation[]) {
  const matched=pairs(expected,actual), seen=new Set(matched.map(pair=>pair.expected));
  const shouldAdmit=expected.filter(item=>item.trendEligible===true).length;
  const shouldExclude=expected.filter(item=>item.trendEligible===false).length;
  const admitted=expected.filter((item,index)=>item.trendEligible===true && seen.has(index)).length;
  const falselyAdmitted=expected.filter((item,index)=>item.trendEligible===false && seen.has(index)).length;
  return {shouldAdmit,admitted,falselyExcluded:shouldAdmit-admitted,shouldExclude,excluded:shouldExclude-falselyAdmitted,falselyAdmitted,
    unexpected:actual.length-matched.length,admissionRecall:shouldAdmit ? admitted/shouldAdmit : null,
    exclusionAccuracy:shouldExclude ? (shouldExclude-falselyAdmitted)/shouldExclude : null};
}
