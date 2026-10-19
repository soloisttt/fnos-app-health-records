import { getDatabase } from '../database/client';
import { createError } from 'h3';
import type { UnverifiedPreviousObservation } from '../domain/health-record';
import type { AiEvidence, AiObservation } from './ai-extraction.service';

const compact = (value: string | null | undefined) => (value || '').normalize('NFKC').toLowerCase().replace(/[\s|｜:：,，()（）]/g, '');
function evidence(value: string): AiEvidence[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export function readUnverifiedPreviousObservations(reportId: string): UnverifiedPreviousObservation[] {
  const row = getDatabase().prepare('SELECT fields_json AS fields FROM report_extractions WHERE report_id=? ORDER BY rowid DESC LIMIT 1')
    .get(reportId) as {fields: string} | undefined;
  try {
    const items = JSON.parse(row?.fields || '{}').unverifiedPreviousObservations;
    return Array.isArray(items) ? items.filter(item => item && typeof item.itemName === 'string'
      && typeof item.resultText === 'string' && typeof item.sourceText === 'string'
      && Array.isArray(item.sourceLineIds) && typeof item.reason === 'string') : [];
  } catch { return []; }
}

function resultIds(entry: AiEvidence) {
  const source = entry.table?.sourceMap?.result;
  return source && !source.inherited ? source.sourceLineIds : [];
}

/** Compare acquisition sources, not counts: a changed reading at the same cell supersedes the old reading. */
export function observationSourceCovered(previous: Pick<AiObservation,'itemName'|'itemCode'|'method'|'evidence'|'examination'>, next: AiObservation) {
  for (const key of ['timeText', 'specimen', 'method'] as const) {
    const before = previous.examination?.[key], after = next.examination?.[key];
    if ((before || after) && compact(before) !== compact(after)) return false;
  }
  if (previous.method && next.method && compact(previous.method) !== compact(next.method)) return false;
  const names = [previous.itemName, previous.itemCode].map(compact).filter(Boolean);
  const sameName = [next.itemName, next.itemCode].some(name => names.includes(compact(name)));
  return previous.evidence.some(old => next.evidence.some(current => {
    if (old.pageNumber !== current.pageNumber) return false;
    if (old.examinationSourceKey && current.examinationSourceKey && old.examinationSourceKey !== current.examinationSourceKey) return false;
    const oldIds = resultIds(old), newIds = resultIds(current);
    if (oldIds.length && newIds.length) return oldIds.length === newIds.length && oldIds.every(id => newIds.includes(id))
      && (sameName || Boolean(compact(old.table?.sourceMap?.item?.text))
        && compact(old.table?.sourceMap?.item?.text) === compact(current.table?.sourceMap?.item?.text));
    // Legacy evidence without field IDs needs the same printed row, not merely a same-name result elsewhere.
    return sameName && Boolean(compact(old.quote)) && compact(old.quote) === compact(current.quote);
  }));
}

/** One current comparison list in the existing extraction snapshot; no old rows are republished. */
export function collectUnverifiedPreviousObservations(reportId: string, next: AiObservation[]) {
  const db = getDatabase();
  const old = db.prepare(`SELECT o.item_name AS itemName,o.item_code AS itemCode,o.section_name AS sectionName,
    o.result_text AS resultText,o.unit,o.method,o.evidence_json AS evidenceJson,
    e.time_text AS timeText,e.specimen,e.method AS examinationMethod
    FROM observations o LEFT JOIN observation_examinations l ON l.observation_id=o.id
    LEFT JOIN report_examinations e ON e.id=l.examination_id WHERE o.report_id=? AND NOT EXISTS
      (SELECT 1 FROM observation_field_overrides v WHERE v.observation_id=o.id)`)
    .all(reportId) as Array<{itemName:string;itemCode:string|null;sectionName:string|null;resultText:string;unit:string|null;method:string|null;evidenceJson:string;timeText:string|null;specimen:string|null;examinationMethod:string|null}>;
  const entries: UnverifiedPreviousObservation[] = [];
  for (const item of old) {
    const sources = evidence(item.evidenceJson);
    const prior = {...item, evidence:sources, numericValue:null, normalizedName:null,
      examination:{timeText:item.timeText || '',specimen:item.specimen || '',method:item.examinationMethod || ''},
      referenceLow:null,referenceHigh:null,referenceText:null,abnormalFlag:null} satisfies AiObservation;
    if (next.some(current => observationSourceCovered(prior,current) && (
      compact(current.resultText) === compact(item.resultText) && compact(current.unit) === compact(item.unit)
      || !current.evidence.some(source=>source.imageOnly || source.nameCorrected || source.ocrLowConfidence)
        && (!item.unit || Boolean(current.unit))
    ))) continue;
    const first = sources[0];
    entries.push({itemName:item.itemName,itemCode:item.itemCode,sectionName:item.sectionName,
      resultText:item.resultText,unit:item.unit,pageNumber:first?.pageNumber || null,
      sourceLineIds:first ? resultIds(first) : [],sourceText:first?.quote || '',examinationSourceKey:first?.examinationSourceKey || null,
      reason:'本次提取仍未核实，已退出正常指标和趋势；上次识别值仅供对照原件'});
  }
  const active = db.prepare('SELECT item_name AS itemName,evidence_json AS evidenceJson FROM observations WHERE report_id=?')
    .all(reportId) as Array<{itemName:string;evidenceJson:string}>;
  const carried = readUnverifiedPreviousObservations(reportId).filter(item => !next.some(current =>
    (compact(current.resultText) === compact(item.resultText) && compact(current.unit) === compact(item.unit)
      || !current.evidence.some(source=>source.imageOnly || source.nameCorrected || source.ocrLowConfidence) && (!item.unit || Boolean(current.unit)))
    && compact(current.itemName) === compact(item.itemName) && current.evidence.some(source => source.pageNumber === item.pageNumber
      && (!item.examinationSourceKey || source.examinationSourceKey===item.examinationSourceKey)
      && compact(source.quote) === compact(item.sourceText))) && !active.some(current => compact(current.itemName) === compact(item.itemName)
        && evidence(current.evidenceJson).some(source => source.pageNumber === item.pageNumber && compact(source.quote) === compact(item.sourceText))));
  return [...new Map([...entries,...carried].map(item => [JSON.stringify([compact(item.itemName),item.pageNumber,item.sourceLineIds,item.examinationSourceKey,compact(item.sourceText),item.resultText,item.unit]),item])).values()];
}

/** Called inside the manual-create transaction; reviewing a stale comparison must not consume a newer snapshot. */
export function consumeUnverifiedPreviousObservation(reportId: string, index: unknown, expectedVersion: unknown) {
  const db = getDatabase();
  const version = db.prepare('SELECT source_version AS version FROM reports WHERE id=?').get(reportId)?.version;
  const items = readUnverifiedPreviousObservations(reportId);
  if (!Number.isInteger(index) || !Number.isInteger(expectedVersion) || expectedVersion !== version || !items[index as number])
    throw createError({statusCode:409,statusMessage:'识别对照已变化，请刷新后重新核对'});
  const reviewed = items.splice(index as number,1)[0];
  const row = db.prepare('SELECT id,fields_json AS fields FROM report_extractions WHERE report_id=? ORDER BY rowid DESC LIMIT 1')
    .get(reportId) as {id:string;fields:string};
  db.prepare('UPDATE report_extractions SET fields_json=? WHERE id=?')
    .run(JSON.stringify({...JSON.parse(row.fields),unverifiedPreviousObservations:items}),row.id);
  return reviewed;
}
