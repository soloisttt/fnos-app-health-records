import { getDatabase } from '../database/client';
import { rebuildOcrPages, localObservationsForLine } from './ai-input-planner.service';

/** Reattach legacy unit provenance only when the same OCR row proves every field. */
export function repairLegacyObservationUnitEvidence(reportId: string) {
  const db = getDatabase();
  const rows = db.prepare(`SELECT o.id,o.item_name AS itemName,o.result_text AS resultText,
    o.numeric_value AS numericValue,o.unit,o.evidence_json AS evidenceJson
    FROM observations o JOIN observation_normalizations n ON n.observation_id=o.id
    WHERE o.report_id=? AND n.excluded_reason='结果单位无法回指 OCR 证据，禁止进入默认趋势'
    AND NOT EXISTS(SELECT 1 FROM observation_field_overrides m WHERE m.observation_id=o.id)`)
    .all(reportId) as Array<{id:string;itemName:string;resultText:string;numericValue:number|null;unit:string|null;evidenceJson:string}>;
  if (!rows.length) return 0;
  const pages = db.prepare(`SELECT p.id AS pageId,p.page_number AS pageNumber,
    (SELECT lines_json FROM ocr_results WHERE page_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) AS linesJson
    FROM report_pages p WHERE p.report_id=? ORDER BY p.page_number`).all(reportId)
    .filter(p=>typeof p.linesJson==='string') as Array<{pageId:string;pageNumber:number;linesJson:string}>;
  const rebuilt = rebuildOcrPages(pages);
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  let updated=0;
  for (const row of rows) {
    let evidence: any[];
    try { evidence=JSON.parse(row.evidenceJson); } catch { continue; }
    if (!Array.isArray(evidence) || !row.unit || row.numericValue===null) continue;
    let changed=false;
    const next=evidence.map(entry=>{
      if (!entry || entry.table?.sourceMap?.unit || !Array.isArray(entry.table?.rowSourceLineIds)) return entry;
      const page=rebuilt.find(p=>p.pageNumber===entry.pageNumber);
      if (!page || (entry.pageId && entry.pageId!==page.pageId)) return entry;
      const oldIds=new Set(entry.table.rowSourceLineIds);
      const matches=page.lines.filter(line=>!line.tableStructureUnsafe && line.sourceLineIds.every(id=>oldIds.has(id)))
        .flatMap(line=>localObservationsForLine(line).filter(fact=>
          compact(fact.itemName)===compact(row.itemName) && fact.numericValue===row.numericValue
          && compact(fact.resultText)===compact(row.resultText) && fact.unit && compact(fact.unit)===compact(row.unit!)
          && fact.sourceMap.unit && !fact.sourceMap.unit.inherited && fact.sourceMap.unit.sourceLineIds.length
        ).map(fact=>({line,fact})));
      if (matches.length!==1) return entry;
      const {line,fact}=matches[0];
      changed=true;
      return {...entry,table:{...entry.table,headerText:line.tableHeaderText,
        headerSourcePageNumber:line.tableHeaderSourcePageNumber,
        headerSourceLineIds:line.tableHeaderSourceLineIds || [],rowSourceLineIds:line.sourceLineIds,
        sourceMap:fact.sourceMap}};
    });
    if (changed) {
      updated+=Number(db.prepare('UPDATE observations SET evidence_json=? WHERE id=? AND evidence_json=?')
        .run(JSON.stringify(next),row.id,row.evidenceJson).changes);
    }
  }
  return updated;
}
