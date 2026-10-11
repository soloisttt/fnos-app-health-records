/** Offline replay: immutable SQLite input, disposable runtime, no provider calls.
 * Outputs counts and keyed fingerprints only; never report text or results.
 * Usage: node --import tsx scripts/evaluate-ocr-extraction.ts INPUT.sqlite OUTPUT.json KEYFILE [AUDIT.sqlite]
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AiObservation } from '../packages/server/services/ai-extraction.service';

const [input, output, keyFile, auditDatabase] = process.argv.slice(2);
if (!input || !output || !keyFile) throw new Error('Expected INPUT.sqlite OUTPUT.json KEYFILE');
const paths = [input, output, keyFile, ...(auditDatabase ? [auditDatabase] : [])].map(path => resolve(path));
if (new Set(paths).size !== paths.length) throw new Error('Input, output, key and audit database must be separate');
const runtime = mkdtempSync(join(tmpdir(), 'ocr-eval-runtime-'));
mkdirSync(join(runtime, 'db'));
const source = new DatabaseSync(resolve(input), { readOnly: true });
await backup(source, join(runtime, 'db/health-records.sqlite'));
source.close();
process.env.STORAGE_DIR = runtime;
process.env.LOG_DIR = join(runtime,'logs');
process.env.AI_INPUT_DEBUG_LOG = '0';
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
const key = readFileSync(keyFile);
const fingerprint = (value: unknown) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
const { getDatabase, closeDatabaseForTests } = await import('../packages/server/database/client.ts');
const { rebuildOcrPages } = await import('../packages/server/services/ai-input-planner.service.ts');
const { executeAiExtractionPlan } = await import('../packages/server/services/ai-extraction-orchestrator.service.ts');
const { normalizeAiExtraction, persistAiExtraction } = await import('../packages/server/services/ai-extraction.service.ts');
try {
  const db = getDatabase();
  const reports = db.prepare('SELECT id FROM reports ORDER BY id').all() as Array<{ id: string }>;
  const result: Array<Record<string, unknown>> = [];
  for (const [index, report] of reports.entries()) {
    const rows = db.prepare(`SELECT p.id AS pageId, p.page_number AS pageNumber,
      (SELECT o.lines_json FROM ocr_results o JOIN processing_jobs j ON j.id=o.job_id AND j.status='completed'
        WHERE o.page_id=p.id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS linesJson
      FROM report_pages p WHERE report_id=? ORDER BY page_number`).all(report.id) as Array<{ pageId: string; pageNumber: number; linesJson: string | null }>;
    const pages = rebuildOcrPages(rows.filter((r): r is typeof r & {linesJson: string} => r.linesJson !== null));
    const facts = pages.flatMap(p => p.lines.flatMap(l => l.localObservations.map(f => ({
      identity: fingerprint([p.pageId, f.sourceMap.item.sourceLineIds, f.sourceMap.result.sourceLineIds, f.itemName]),
      semantic: fingerprint([p.pageId,f.itemName]), numeric: fingerprint(f.numericValue),
      value: fingerprint([f.resultText, f.numericValue]), unit: fingerprint(f.unit), reference: fingerprint(f.referenceText),
      hasUnit: Boolean(f.unit), hasReference: Boolean(f.referenceText),
    }))));
    const metrics: Record<string, unknown> = {
      report: index + 1, pages: rows.length, ocrPages: pages.length,
      facts, localCount: facts.length, candidates: pages.reduce((n,p)=>n+p.candidateRowCount,0),
      unsafeRows: pages.flatMap(p=>p.lines).filter(l=>l.tableStructureUnsafe && l.candidate).length,
      accuracy: {status:'not_scored',reason:'no_independent_expected_observations'},
      stages: {
        ocr: {status:'replayed',reason:'stored_ocr_lines_no_engine_execution'},
        ai: {status:'skipped',mode:'offline',modelCalls:0,visionCalls:0,reason:'stored_response_replay_not_model_evaluation'},
        extraction: {status:'skipped',reason:'pending_replay'},
        persistence: {status:'skipped',reason:'pending_replay'},
        trend: {status:'skipped',reason:'replay_metrics_only_use_layout_pipeline_for_scored_trends'},
      },
    };
    if (rows.length && rows.every(r => r.linesJson !== null)) {
      const recorded = db.prepare(`SELECT result_json FROM ai_extraction_units WHERE report_id=? AND job_id=(
        SELECT id FROM processing_jobs WHERE report_id=? AND job_type='ai_extract' AND status='completed'
        ORDER BY created_at DESC,id DESC LIMIT 1) AND status IN ('completed','warning') AND result_json IS NOT NULL`).all(report.id,report.id) as Array<{result_json:string}>;
      const responses = recorded.map(r=>JSON.parse(r.result_json));
      const jobId = `offline-eval-${randomUUID()}`;
      db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,'ai_extract','processing','offline-eval',?)").run(jobId,report.id,jobId);
      let activeStage = 'extraction';
      try {
        const replay = await executeAiExtractionPlan(jobId, report.id, async request => {
          const fields: AiObservation[] = responses.flatMap(r=>r.fields?.observations || []);
          const observations = fields.filter(o=>o.evidence?.some(e=>request.pageNumbers?.includes(e.pageNumber)));
          return { ...normalizeAiExtraction({observations}), provider:'offline',model:'recorded-response',promptVersion:'offline',
            rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0 };
        }, {visionReview: async()=>null});
        metrics.finalCount = replay.result.fields.observations.length;
        (metrics.stages as Record<string,unknown>).extraction = {status:'executed',mode:'stored_response_replay',recordedUnits:responses.length};
        metrics.unmatched = replay.unmatchedCandidates;
        metrics.recordedUnits = responses.length;
        metrics.finalFacts = replay.result.fields.observations.map(o=>({
          identity:fingerprint([o.itemName,o.evidence.map(e=>[e.pageNumber,e.quote]),o.examination]),
          semantic:fingerprint([o.itemName,[...new Set(o.evidence.map(e=>e.pageNumber))].sort(),o.examination?.timeText]), numeric:fingerprint(o.numericValue),
          value:fingerprint([o.resultText,o.numericValue]),unit:fingerprint(o.unit),reference:fingerprint(o.referenceText),
        }));
        activeStage = 'persistence';
        persistAiExtraction(report.id, jobId, replay.result, replay.inputCharacters);
        metrics.persistedCount = Number((db.prepare('SELECT count(*) AS n FROM observations WHERE report_id=?').get(report.id) as {n:number}).n);
        (metrics.stages as Record<string,unknown>).persistence = {status:'executed',count:metrics.persistedCount};
      } catch (error) {
        const code = (error as {code?:unknown})?.code;
        metrics.replayError = typeof code === 'string' && /^[A-Z_]{2,80}$/.test(code) ? code : 'REPLAY_FAILED';
        (metrics.stages as Record<string,unknown>)[activeStage] = {status:'failed',reason:metrics.replayError};
        if (activeStage === 'extraction') (metrics.stages as Record<string,unknown>).persistence = {status:'skipped',reason:'extraction_failed'};
      }
    } else {
      metrics.replayError = 'INCOMPLETE_OCR';
      for (const stage of ['extraction','persistence']) (metrics.stages as Record<string,unknown>)[stage] = {status:'skipped',reason:'incomplete_ocr'};
    }
    result.push(metrics);
  }
  const summary = {reports:result.length, pages:result.reduce((n,r)=>n+Number(r.pages),0),
    ocrPages:result.reduce((n,r)=>n+Number(r.ocrPages),0), localCount:result.reduce((n,r)=>n+Number(r.localCount),0),
    finalCount:result.reduce((n,r)=>n+Number(r.finalCount||0),0), errors:result.filter(r=>r.replayError).map(r=>({report:r.report,reason:r.replayError}))};
  if (auditDatabase) {
    await backup(db,resolve(auditDatabase)); // Private data snapshot, never a log or public artifact.
    chmodSync(resolve(auditDatabase), 0o600);
  }
  writeFileSync(output, JSON.stringify({summary,reports:result},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(summary));
} finally {
  closeDatabaseForTests();
  rmSync(runtime,{recursive:true,force:true});
}
