export type MeasurementComparator = '<' | '≤' | '>' | '≥';

/** Keep a printed limit separate from its scalar boundary; this is not an exact measurement. */
export function splitMeasurementBound(resultText: string) {
  const text = resultText.normalize('NFKC').trim().replace(/^[↑↓▲▼⬆⬇]\s*/, '');
  const match = text.match(/^(<=|>=|[<>≤≥])\s*/);
  return {
    comparator: match ? (match[1] === '<=' ? '≤' : match[1] === '>=' ? '≥' : match[1]) as MeasurementComparator : null,
    text: match ? text.slice(match[0].length) : text,
  };
}
