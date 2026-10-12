// This projection is shared by administrator and member feedback. Never return
// complete OCR status or AI settings: both contain private configuration.
type OcrInput = {
  available: boolean;
  runtime?: { engine?: string; backend?: string; modelVersion?: string; pythonVersion?: string; rapidocrVersion?: string; pymupdfVersion?: string } | null;
  tableEnhancement?: { tableModel: boolean; layoutModel: boolean };
};
type AiInput = { enabled: boolean; visionEnabled: boolean };
function version(value: string | undefined) {
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._+\-]{0,79}$/.test(value) ? value : null;
}
export function diagnosticFeatures(ocr: OcrInput | null, ai: AiInput | null) {
  return {
    ocr: ocr ? {
      available: ocr.available,
      engine: version(ocr.runtime?.engine || ocr.runtime?.backend),
      modelVersion: version(ocr.runtime?.modelVersion),
      pythonVersion: version(ocr.runtime?.pythonVersion),
      rapidocrVersion: version(ocr.runtime?.rapidocrVersion),
      pymupdfVersion: version(ocr.runtime?.pymupdfVersion),
      tableModel: ocr.tableEnhancement?.tableModel ?? null,
      layoutModel: ocr.tableEnhancement?.layoutModel ?? null
    } : null,
    ai: ai ? { enabled: ai.enabled, visionEnabled: ai.visionEnabled } : null
  };
}
