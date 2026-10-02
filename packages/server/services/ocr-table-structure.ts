import { isCurrentResultColumn, isExplicitOcrTableHeader } from './ocr-table-columns';

export type OcrTableCell = { table: string; row: number; column: number; columns: number };
type PositionedText = { id?: unknown; text?: unknown; box?: unknown; confidence?: unknown; tableUnsafe?: boolean; tableCell?: unknown };

function geometry(box: unknown) {
  if (!Array.isArray(box)) return null;
  const b = box.flat() as number[];
  if (![4, 8].includes(b.length) || !b.every(Number.isFinite)) return null;
  const xs = b.length === 4 ? [b[0], b[2]] : b.filter((_, i) => i % 2 === 0);
  const ys = b.length === 4 ? [b[1], b[3]] : b.filter((_, i) => i % 2 === 1);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return right > left && bottom > top
    ? { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2, height: bottom - top }
    : null;
}

const nameHeader = /^(项目名称|项目|名称|参数|检验项目|检测项目|测定项目)$/;
const prefixHeader = /^(序号|缩写|英文缩写|代码)$/;
const headerLabel = /^(项目名称|项目|名称|参数|检验项目|检测项目|测定项目|序号|缩写|英文缩写|代码|结果|本次结果|检验结果|检查结果|测定值|实测值?|测量值|单位|异常|异常标志|标志|标记|参考范围|参考值|参考区间|历史结果|上次结果|前次结果|方法|方法学|检测方法)$/;
const administrativeLabel = /(?:姓名|日期|时间|签名|审核|医生|标本|送检|检验者|备注|声明|报告单|报告编号|仅供|仅对)/;
const recognitionMarker = /^[【[]\s*(?:深圳)?(?:HR|R)\s*[】\]]$/i;
const resultText = /^(?:[↑↓▲▼⬆⬇↗↘]?\s*(?:<=|>=|[<>≤≥])?\s*[-+]?\d+(?:\s*\.\s*\d+)?(?:[eE][-+]?\d+)?\s*[%‰↑↓▲▼⬆⬇↗↘]?|[-+]{1,3}|阴性|阳性|弱阳性|正常|异常|未见(?:异常)?|未检出|清亮|浑浊)$/;

/** A single OCR box may contain the same code in both abbreviation/name columns. */
export function duplicatedOcrCodeName(text: string): string | null {
  const match = text.match(/^([A-Za-z][A-Za-z _-]+)\s+([A-Za-z][A-Za-z0-9_-]+)$/);
  const compact = (value: string) => value.replace(/[ _-]/g, '').toUpperCase();
  return match && compact(match[1]).length >= 3 && compact(match[1]) === compact(match[2]) ? match[2] : null;
}

/** Do not strip numeric identifiers such as B12, D3 or CA19.9 from a name. */
export function duplicatedOcrResultName(text: string, result: string): string | null {
  if (!result || !text.endsWith(result) || !/\d/.test(result)) return null;
  const name = text.slice(0, -result.length).trim();
  return name.length >= 2 && /[\u3400-\u9fff)）]$/.test(name) ? name : null;
}

/**
 * Recover explicit header regions independently of the optional table model.
 * Repeated project headers each own a panel, its rows and its column meanings.
 * Only unique name/result pairs are promoted. Missing/conflicting results stay
 * marked unsafe, and useful model cells are never overwritten.
 */
export function recoverHeaderAlignedTable<T extends PositionedText>(lines: T[]): T[] {
  const items = lines.flatMap((line, index) => {
    const box = geometry(line.box);
    return box && typeof line.text === 'string' ? [{ line, index, box, text: line.text.trim() }] : [];
  });
  const headings = items.filter(item => headerLabel.test(item.text));
  const anchors = headings.filter(item => nameHeader.test(item.text));
  const bands = new Map<string, typeof items>();
  for (const anchor of anchors) {
    const band = headings.filter(item => Math.abs(item.box.y - anchor.box.y) <= Math.max(item.box.height, anchor.box.height) * .9)
      .sort((a, b) => a.box.x - b.box.x);
    bands.set(band.map(item => item.index).join(','), band);
  }
  const mapping = new Map<number, OcrTableCell>();
  const unsafe = new Set<number>();
  const usedTables = new Set(lines.flatMap(line => validOcrTableCell(line.tableCell) ? [line.tableCell.table] : []));
  let tableNumber = 99;
  const coveredHeaders = new Set<number>();
  for (const band of [...bands.values()].sort((a, b) => b.length - a.length)) {
    if (band.some(item => coveredHeaders.has(item.index))) continue;
    const starts = band.flatMap((item, index) => nameHeader.test(item.text) ? [index] : []);
    // An abbreviation/serial heading belongs to the project following it.
    const groupStarts = starts.map((start, index) => {
      let first = start;
      while (first > (starts[index - 1] ?? -1) + 1 && prefixHeader.test(band[first - 1].text)) first--;
      return first;
    });
    for (let groupIndex = 0; groupIndex < groupStarts.length; groupIndex++) {
      const headers = band.slice(groupStarts[groupIndex], groupStarts[groupIndex + 1]);
      const nameCol = headers.findIndex(item => nameHeader.test(item.text));
      const resultCols = headers.flatMap((item, i) => isCurrentResultColumn(item.text) ? [i] : []);
      if (nameCol < 0 || resultCols.length !== 1 || headers.length < 3
        || !isExplicitOcrTableHeader(headers.map(item => item.text).join(' | '))
        || headers.some(item => /历史|上次|前次/.test(item.text))) continue;
      const anchor = headers[nameCol];
      const height = Math.max(...headers.map(item => item.box.height));
      const first = headers[0], last = headers[headers.length - 1];
      const slope = (last.box.y - first.box.y) / (last.box.x - first.box.x);
      if (!Number.isFinite(slope) || Math.abs(slope) > .08) continue;
      const y = (item: typeof anchor) => item.box.y - slope * (item.box.x - anchor.box.x);
      // Do not silently drop unrecognised reference/history/date/chart columns.
      // Dedicated matrix and device-chart parsers retain their full header.
      const nextPanel = band[groupStarts[groupIndex + 1]];
      const unsupportedHeader = items.some(item => item.box.x >= first.box.left - height
        && item.box.x < (nextPanel?.box.left ?? Infinity)
        && Math.abs(y(item) - y(anchor)) <= height * .65
        && !headers.includes(item) && /参考|范围|历史|上次|前次|预测|预计|标准|(?:19|20|21)\d{2}[-/.年]/.test(item.text));
      if (unsupportedHeader) continue;
      // Left-aligned headings describe column starts, not centre midpoints.
      const edges = [first.box.left - height, ...headers.slice(1).map(item => item.box.left - height), last.box.right + height / 2];
      if (edges.some((edge, i) => i > 0 && edge <= edges[i - 1])) continue;
      const column = (item: typeof anchor) => {
        if (item.box.left >= edges[nameCol] && item.box.left < edges[nameCol + 1] && /\p{L}/u.test(item.text)) return nameCol;
        return edges.findIndex((edge, i) => item.box.x >= edge && item.box.x < edges[i + 1]);
      };
      const nextHeader = anchors.filter(item => y(item) > y(anchor) + height
        && item.box.x >= edges[0] && item.box.x < edges[edges.length - 1])
        .reduce((bottom, item) => Math.min(bottom, y(item) - item.box.height / 2), Infinity);
      const body = items.filter(item => y(item) > y(anchor) + Math.min(item.box.height, anchor.box.height) / 2
        && y(item) < nextHeader && column(item) >= 0 && !recognitionMarker.test(item.text));
      // Protect model structure per region, so a good neighbouring table does
      // not disable fallback on the rest of the page.
      if ([...headers, ...body].some(item => validOcrTableCell(item.line.tableCell) && !item.line.tableUnsafe)) continue;
      const rowNames = body.filter(item => column(item) === nameCol && /\p{L}/u.test(item.text)
        && !/[：:；;。]/.test(item.text) && !administrativeLabel.test(item.text))
        .sort((a, b) => y(a) - y(b));
      const rows = new Map<number, { row: number; column: number; unsafe: boolean }>();
      const conflicting = new Set<number>();
      rowNames.forEach((name, rowIndex) => {
        const sameRow = body.filter(item => Math.abs(y(item) - y(name)) < Math.min(item.box.height, name.box.height) * .65);
        const results = sameRow.filter(item => column(item) === resultCols[0] && !/^[↑↓↗↘*★☆]+$/.test(item.text));
        if (sameRow.filter(item => column(item) === nameCol && /\p{L}/u.test(item.text)).length !== 1) return;
        const result = results[0];
        // A merged name/value OCR box is usable only if the independent result
        // box overlaps it and repeats the exact printed suffix.
        const duplicatedResult = result && duplicatedOcrResultName(name.text, result.text)
          && name.box.right >= result.box.left && name.box.left < result.box.left;
        const duplicatedCode = nameCol > 0 && prefixHeader.test(headers[nameCol - 1].text)
          && duplicatedOcrCodeName(name.text) && name.box.left < edges[nameCol] && name.box.right > edges[nameCol];
        const crossed = [name, ...results].some(item => {
          if (item === name && (duplicatedResult || duplicatedCode)) return false;
          const col = column(item);
          return (Math.min(item.box.right, edges[col + 1]) - Math.max(item.box.left, edges[col])) / (item.box.right - item.box.left) < .8;
        });
        const rowUnsafe = crossed || results.length !== 1 || !resultText.test(result?.text || '')
          || [name, ...results].some(item => item.line.confidence != null && Number(item.line.confidence) < .65)
          || headers.some((header, col) => header.text === '单位' && sameRow.filter(item => column(item) === col).length > 1);
        const nextName = rowNames[rowIndex + 1];
        const bottom = Math.min(nextName ? y(nextName) - height / 2 : Infinity, y(name) + height * 3);
        for (const item of body) {
          const col = column(item);
          const auxiliary = ![nameCol, resultCols[0]].includes(col) && headers[col]?.text !== '单位';
          if (sameRow.includes(item) || (auxiliary && y(item) >= y(name) && y(item) + item.box.height / 2 < bottom)) {
            if (rows.has(item.index) || conflicting.has(item.index)) { rows.delete(item.index); conflicting.add(item.index); continue; }
            rows.set(item.index, { row: rowIndex + 1, column: col, unsafe: rowUnsafe });
          }
        }
      });
      if (!rows.size) continue;
      while (usedTables.has(`table_${tableNumber}`) && tableNumber >= 0) tableNumber--;
      if (tableNumber < 0) break;
      const table = `table_${tableNumber--}`;
      usedTables.add(table);
      headers.forEach((item, column) => {
        mapping.set(item.index, { table, row: 0, column, columns: headers.length });
        coveredHeaders.add(item.index);
      });
      rows.forEach(({ unsafe: rowUnsafe, ...cell }, index) => {
        mapping.set(index, { table, ...cell, columns: headers.length });
        if (rowUnsafe) unsafe.add(index);
      });
    }
  }
  return mapping.size ? lines.map((line, index) => mapping.has(index)
    ? { ...line, tableUnsafe: unsafe.has(index), tableCell: mapping.get(index) } : line) : lines;
}

export function validOcrTableCell(value: unknown): value is OcrTableCell {
  if (!value || typeof value !== 'object') return false;
  const v = value as OcrTableCell;
  return typeof v.table === 'string' && /^table_\d{1,2}$/.test(v.table)
    && Number.isInteger(v.row) && v.row >= 0 && v.row <= 1024
    && Number.isInteger(v.columns) && v.columns >= 2 && v.columns <= 64
    && Number.isInteger(v.column) && v.column >= 0 && v.column < v.columns;
}
