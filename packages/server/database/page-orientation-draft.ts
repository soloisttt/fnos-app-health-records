import type { DatabaseSync } from 'node:sqlite';

// Unnumbered draft: retain the OCR orientation when a page is rotated without re-recognition.
export function ensurePageOrientationDraft(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(report_pages)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'ocr_rotation')) return;
  db.exec('SAVEPOINT page_orientation_draft');
  try {
    db.exec('ALTER TABLE report_pages ADD COLUMN ocr_rotation INTEGER');
    db.exec(`UPDATE report_pages SET ocr_rotation=rotation
      WHERE EXISTS (SELECT 1 FROM ocr_results WHERE ocr_results.page_id=report_pages.id)`);
    db.exec('RELEASE page_orientation_draft');
  } catch (error) {
    db.exec('ROLLBACK TO page_orientation_draft; RELEASE page_orientation_draft');
    throw error;
  }
}
