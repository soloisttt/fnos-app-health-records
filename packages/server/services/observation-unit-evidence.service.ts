import { getDatabase } from "../database/client";

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())) : [];
}

/** Read only local planner provenance, and verify every referenced line against this report's OCR. */
export function linkedObservationUnitQuotes(reportId: string, evidenceJson: string): string[] {
  let entries: any[];
  try { const parsed = JSON.parse(evidenceJson); if (!Array.isArray(parsed)) return []; entries = parsed; } catch { return []; }
  const scoped = entries.filter(entry => entry?.table?.sourceMap?.unit);
  if (!scoped.length) return [];
  const pages = getDatabase().prepare(`SELECT p.page_number AS pageNumber, o.lines_json AS linesJson
    FROM report_pages p JOIN ocr_results o ON o.page_id = p.id WHERE p.report_id = ?`).all(reportId) as Array<{ pageNumber: number; linesJson: string }>;
  const lines = new Map<string, { page: number; text: string }>();
  const ambiguous = new Set<string>();
  for (const page of pages) {
    let values: any[];
    try { const parsed = JSON.parse(page.linesJson); if (!Array.isArray(parsed)) continue; values = parsed; } catch { continue; }
    values.forEach((line, index) => {
      if (!line || typeof line.text !== 'string') return;
      const id = typeof line.id === 'string' && line.id.trim() ? line.id.trim() : `page_${page.pageNumber}_line_${index + 1}`;
      const key = `${page.pageNumber}:${id}`;
      if (lines.has(key)) ambiguous.add(key);
      lines.set(key, { page: page.pageNumber, text: line.text });
    });
  }
  const quotes: string[] = [];
  for (const entry of scoped) {
    const unit = entry.table.sourceMap.unit;
    const rowIds = ids(entry.table.rowSourceLineIds);
    const headerIds = ids(entry.table.headerSourceLineIds);
    const sourceIds = ids(unit.sourceLineIds);
    const rowPage = Number(entry.pageNumber);
    if (!rowIds.length || !sourceIds.length || !rowIds.every(id => !ambiguous.has(`${rowPage}:${id}`) && lines.has(`${rowPage}:${id}`))) continue;
    // Column units must originate in this row; inherited units must use this table's explicit header.
    const allowed = unit.inherited === true ? headerIds : rowIds;
    if (!sourceIds.every(id => allowed.includes(id))) continue;
    let sourcePage = unit.inherited === true ? Number(entry.table.headerSourcePageNumber) : rowPage;
    if (unit.inherited === true && !sourcePage) {
      // Legacy provenance lacks a page: accept only when every id unambiguously resolves to one page.
      const candidatePages = [...new Set(pages.map(page => page.pageNumber))].filter(page => page <= rowPage
        && sourceIds.every(id => lines.has(`${page}:${id}`)));
      if (candidatePages.length !== 1) continue;
      sourcePage = candidatePages[0];
    }
    if (!Number.isInteger(sourcePage) || sourcePage < 1 || sourcePage > rowPage
      || !sourceIds.every(id => lines.has(`${sourcePage}:${id}`) && !ambiguous.has(`${sourcePage}:${id}`))) continue;
    const printedUnit = typeof unit.text === 'string' ? unit.text.trim() : '';
    if (!printedUnit) continue;
    let sourceTexts = sourceIds.map(id => lines.get(`${sourcePage}:${id}`)!.text);
    // One OCR line may contain several project/unit columns. Its other units
    // cannot establish the selected field's provenance.
    if (sourceTexts.length === 1) {
      const cells = sourceTexts[0].split(/[|｜]/);
      if (cells.length > 1 && Array.isArray(unit.cellIndices) && unit.cellIndices.length) {
        if (!unit.cellIndices.every((index: unknown) => Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < cells.length)) continue;
        sourceTexts = unit.cellIndices.map((index: number) => cells[index]);
      }
    }
    const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const escaped = compact(printedUnit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (sourceTexts.some(text => new RegExp(`(?<![a-zµμ])${escaped}(?![a-zµμ/])`, 'i').test(compact(text)))) {
      quotes.push(printedUnit);
    }
  }
  return quotes;
}
