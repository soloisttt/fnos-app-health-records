/**
 * Scores generated OCR with the production planner. Existing two-positional CLI
 * remains valid. Add --stage=pipeline for persistence/trends, --ai=live and
 * --ai-config=/private/settings.json for real provider calls. Offline is default.
 * AI config uses the existing AiSettingsInput shape; optional apiKeyEnv names an
 * environment variable so credentials need not appear in arguments or the file.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { observationForScore, scoreObservations, scoreContribution, scoreTrendAdmission, visionItemSourceIds } from './ocr-evaluation-score';
import type { AiEvidence, AiExtractionResult, AiObservation } from '../packages/server/services/ai-extraction.service';

type Page = { pageNumber: number; lines: Array<Record<string, unknown>>; engineLines?: Array<Record<string, unknown>>; imagePath?: string | null };
type LayoutCase = { name: string; lines?: Page['lines']; pages?: Page[]; expected: Array<Record<string, unknown>>;
  elapsedMs?: number; ocr?: { status?: string; backend?: string; version?: string; workerSha256?: string; fontSha256?: string } };
const safeCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z_]{2,80}$/.test(code) ? code : 'EVALUATION_FAILED';
};

async function main() {
  const [input, output, ...flags] = process.argv.slice(2);
  if (!input || !output || resolve(input) === resolve(output)) throw new Error('Expected separate OCR_INPUT.json SCORE_OUTPUT.json');
  const options = Object.fromEntries(flags.map(flag => { const index = flag.indexOf('='); return [flag.slice(0,index),flag.slice(index+1)]; }));
  const stage = options['--stage'] || 'ocr', aiMode = options['--ai'] || 'offline';
  if (flags.some(flag => !/^--(?:stage|ai|ai-config|cases)=/.test(flag)) || !['ocr','pipeline'].includes(stage) || !['offline','live'].includes(aiMode)) throw new Error('Invalid evaluation options');
  if (aiMode === 'live' && stage !== 'pipeline') throw new Error('Live AI requires pipeline stage');
  const configPath = options['--ai-config'] || process.env.OCR_EVAL_AI_CONFIG;
  if (aiMode === 'live' && !configPath) throw new Error('Live AI requires an explicit settings file');
  const runtime = mkdtempSync(join(tmpdir(),'ocr-layout-score-'));
  process.env.STORAGE_DIR = runtime;
  process.env.LOG_DIR = join(runtime,'logs');
  process.env.AI_INPUT_DEBUG_LOG = '0';
  const { rebuildOcrPages } = await import('../packages/server/services/ai-input-planner.service.ts');
  const { closeDatabaseForTests, getDatabase } = await import('../packages/server/database/client.ts');
  const { executeAiExtractionPlan } = await import('../packages/server/services/ai-extraction-orchestrator.service.ts');
  const { normalizeAiExtraction, persistAiExtraction, requestAiExtraction, isAiExtractionConfigured } = await import('../packages/server/services/ai-extraction.service.ts');
  const { saveAiSettings } = await import('../packages/server/services/ai-settings.service.ts');
  const { runVisionReview } = await import('../packages/server/services/ai-vision-review.service.ts');
  const { executeAiChatCompletion } = await import('../packages/server/services/ai-runtime.service.ts');
  const { listTrendSeries } = await import('../packages/server/services/records.service.ts');
  try {
    const db = getDatabase();
    if (aiMode === 'live') {
      const config = JSON.parse(readFileSync(configPath!, 'utf8'));
      if (config.apiKeyEnv) { config.apiKey = process.env[String(config.apiKeyEnv)] || ''; delete config.apiKeyEnv; }
      saveAiSettings({ ...config, enabled: true, extractionDepth: 'detailed' });
      if (!isAiExtractionConfigured()) throw new Error('AI_NOT_CONFIGURED');
    } else saveAiSettings({ enabled: false, extractionDepth: 'detailed' });
    const cases = JSON.parse(readFileSync(input,'utf8')) as LayoutCase[];
    if (!Array.isArray(cases)) throw new Error('Expected case array');
    const selected = options['--cases'] ? new Set(options['--cases'].split(',')) : null;
    const results: Array<Record<string, unknown>> = [];
    for (const [index, item] of cases.entries()) {
      if (selected && !selected.has(item.name)) continue;
      const pages = item.pages || [{ pageNumber: 1, lines: item.lines || [] }];
      const expected = item.expected.map(observationForScore);
      const pageId = (number: number) => `eval-${index}-page-${number}`;
      const planned = rebuildOcrPages(pages.map(page => ({ pageId: pageId(page.pageNumber), pageNumber: page.pageNumber, linesJson: JSON.stringify(page.lines) })));
      const boxFor = (pageNumber: number, ids: string[]) => {
        const boxes = pages.find(page => page.pageNumber === pageNumber)?.lines.filter(line => ids.includes(String(line.id))).flatMap(line => {
          const raw = line.box;
          if (!Array.isArray(raw)) return [];
          if (raw.length === 4 && raw.every(value => typeof value === 'number')) return [raw as number[]];
          if (raw.every(value => Array.isArray(value) && value.length === 2)) {
            const points = raw as number[][];
            return [[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]];
          }
          return [];
        }) || [];
        return boxes.length ? [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))] : undefined;
      };
      const withEvidence = (observation: Record<string, unknown>, evidence: AiEvidence[] = []) => {
        const first = evidence[0];
        const compact=(value:unknown)=>String(value || '').normalize('NFKC').replace(/\s+/g,'');
        // Quote identity is source evidence, independent of the returned value.
        // This also anchors short names when normalization omitted table detail.
        const sourceFacts=planned.find(page=>page.pageNumber===first?.pageNumber)?.lines
          .filter(line=>compact(line.text)===compact(first?.quote)).flatMap(line=>line.localObservations) || [];
        const sourceIds=[...new Map(sourceFacts.map(fact=>[JSON.stringify(fact.sourceMap.item.sourceLineIds),fact.sourceMap.item.sourceLineIds])).values()];
        const quoteIds=sourceIds.length===1 ? sourceIds[0] : [];
        const printedName = String(observation.itemName || observation.name || '').normalize('NFKC').replace(/\s+/g,'');
        const nameMatches = pages.find(page => page.pageNumber === first?.pageNumber)?.lines.flatMap(line => {
          const value = String(line.text || '').normalize('NFKC').replace(/\s+/g,'');
          return value.length >= 3 && printedName.includes(value) ? [{id:String(line.id),length:value.length}] : [];
        }) || [];
        // A shared suffix on a wrapped row must not anchor every other item on
        // that page. Use only a unique longest printed name fragment.
        const longest = nameMatches.filter(line=>line.length===Math.max(...nameMatches.map(line=>line.length)));
        const inferredIds = longest.length === 1 ? [longest[0].id] : [];
        const visualItemIds=visionItemSourceIds(printedName,first,planned);
        const ids = [visualItemIds,first?.table?.sourceMap?.item?.sourceLineIds,first?.visionRegion?.sourceLineIds,quoteIds,inferredIds].find(ids=>ids?.length) || [];
        return observationForScore({ ...observation, pageNumber: first?.pageNumber ?? observation.pageNumber,
          ...(ids.length ? { sourceLineIds: ids, sourceBox: boxFor(first.pageNumber, ids) } : {}) });
      };
      const local = planned.flatMap(page => page.lines.flatMap(line => line.localObservations.map(fact => observationForScore({ ...fact,
        sourceLineIds: fact.sourceMap.item.sourceLineIds, sourceBox: boxFor(page.pageNumber,fact.sourceMap.item.sourceLineIds) }))));
      const localScore = scoreObservations(expected, local);
      const skipped = (reason: string) => ({ status: 'skipped', reason });
      const result: Record<string, unknown> = {
        case: index + 1, layout: /^[a-z0-9-]{1,80}$/.test(item.name) ? item.name : `case-${index+1}`,
        ...localScore, ocrElapsedMs: Number(item.elapsedMs || 0),
        stages: { ocr: { status: ['executed','skipped','modified'].includes(item.ocr?.status || '') ? item.ocr!.status : 'replayed',
          reason: item.ocr?.status ? undefined : 'supplied_ocr_lines_not_engine_execution', metadata: item.ocr || null },
          planner: { status: 'executed', score: localScore }, ai: skipped(stage === 'ocr' ? 'ocr_stage_only' : 'offline_no_model_calls'),
          persistence: skipped('ocr_stage_only'), trend: skipped('ocr_stage_only') },
      };
      const stages = result.stages as Record<string, unknown>;
      if (stage === 'pipeline') {
        const reportId = `eval-report-${index}`, memberId = `eval-member-${index}`, jobId = `eval-ai-${index}`;
        db.prepare("INSERT OR IGNORE INTO users(id,display_name) VALUES('eval-owner','Synthetic evaluator')").run();
        db.prepare("INSERT INTO health_members(id,display_name,created_by) VALUES(?,'Synthetic member','eval-owner')").run(memberId);
        db.prepare("INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES(?,'eval-owner','manager','eval-owner')").run(memberId);
        db.prepare("INSERT INTO reports(id,member_id,created_by,report_type,title,status,hospital_name_raw,report_issued_at) VALUES(?,?,'eval-owner','laboratory','Synthetic report','processing','Synthetic institution','2026-10-01')").run(reportId,memberId);
        for (const page of pages) {
          const id = pageId(page.pageNumber), ocrJob = `ocr-${id}`, path = `reports/${id}.png`;
          if (page.imagePath && existsSync(page.imagePath)) { mkdirSync(join(runtime,'reports'),{recursive:true}); copyFileSync(page.imagePath,join(runtime,path)); }
          db.prepare("INSERT INTO report_pages(id,report_id,page_number,original_name,mime_type,storage_path,file_size,sha256) VALUES(?,?,?,'synthetic.png','image/png',?,1,?)").run(id,reportId,page.pageNumber,path,id);
          db.prepare("INSERT INTO processing_jobs(id,report_id,page_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,?,'ocr','completed','evaluation',?)").run(ocrJob,reportId,id,ocrJob);
          db.prepare("INSERT INTO ocr_results(id,job_id,page_id,engine,model_version,lines_json) VALUES(?,?,?,'evaluation-input','evaluation',?)").run(`result-${id}`,ocrJob,id,JSON.stringify(page.lines));
        }
        db.prepare("INSERT INTO processing_jobs(id,report_id,job_type,status,pipeline_version,deduplication_key) VALUES(?,?,'ai_extract','processing','evaluation',?)").run(jobId,reportId,jobId);
        let modelCalls = 0, visionCalls = 0, modelFailures = 0, visionFailures = 0;
        let visionParseFailures = 0;
        const rawText = new Map<string,AiObservation[]>(), rawVision:AiObservation[] = [], acceptedVision:AiObservation[] = [];
        let beforeVision:AiObservation[] | undefined;
        const requests:Array<{route:string;unitType:string;candidateCount:number;pageCount:number;returned:number;status:string}> = [];
        const scored = (items:AiObservation[]) => items.map(fact=>withEvidence(fact as unknown as Record<string,unknown>,fact.evidence));
        let activeStage = 'extraction';
        try {
          const execution = await executeAiExtractionPlan(jobId,reportId,async request => {
            if (aiMode === 'live') {
              modelCalls++;
              const audit={route:request.route || 'unknown',unitType:request.unitType || 'unknown',candidateCount:request.candidateCount || 0,
                pageCount:request.pageNumbers?.length || request.pageCount,returned:0,status:'started'};
              requests.push(audit);
              try {
                const result=await requestAiExtraction(request);
                audit.returned=result.fields.observations.length; audit.status='completed';
                rawText.set(request.unitKey || `request-${modelCalls}`,result.fields.observations);
                return result;
              } catch (error) { modelFailures++; audit.status='failed'; throw error; }
            }
            return { ...normalizeAiExtraction({ observations: [] }), provider:'offline',model:'local-only',promptVersion:'offline',rawResponseJson:'{}',promptTokens:0,completionTokens:0,elapsedMs:0 } satisfies AiExtractionResult;
          }, { visionReview: aiMode === 'offline' ? async () => null : async (input,options) => {
            beforeVision=input.result.fields.observations;
            const result=await runVisionReview(input,{
            ...options,chat:async (config,request) => {
              visionCalls++;
              try {
                const response=await executeAiChatCompletion(config,request);
                try { rawVision.push(...normalizeAiExtraction(JSON.parse((response.content || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))).fields.observations); }
                catch { visionParseFailures++; }
                return response;
              } catch (error) { visionFailures++; throw error; }
            },
          });
            if (result) acceptedVision.push(...result.fields.observations);
            return result;
          } });
          const merged=scored(execution.result.fields.observations);
          const extractionScore = scoreObservations(expected,merged);
          stages.extraction = { status:'executed',mode:aiMode === 'live' ? 'model_and_local_merge' : 'local_only',score:extractionScore,
            units:execution.plan.units.map(unit=>({route:unit.route,unitType:unit.unitType,candidateCount:unit.candidateRowCount})),
            unmatchedCandidates:execution.unmatchedCandidates };
          stages.ai = aiMode === 'live' ? { status:modelCalls || visionCalls ? modelCalls+visionCalls === modelFailures+visionFailures ? 'failed' : 'executed' : 'skipped',
            mode:'live',modelCalls,visionCalls,modelFailures,visionFailures,
            ...(modelCalls || visionCalls ? {} : {reason:'no_model_request_needed'}), score:extractionScore, scoreScope:'merged_model_and_local_observations' }
            : {...skipped('offline_no_model_calls'),mode:'offline',modelCalls:0,visionCalls:0};
          if (aiMode==='live') {
            const acceptedRows=db.prepare("SELECT unit_key AS unitKey,result_json AS resultJson FROM ai_extraction_units WHERE job_id=? AND status IN ('completed','warning') AND result_json IS NOT NULL").all(jobId);
            const acceptedText=acceptedRows.flatMap(row=>(JSON.parse(String(row.resultJson)) as AiExtractionResult).fields.observations);
            const rawActive=acceptedRows.flatMap(row=>rawText.get(String(row.unitKey)) || []);
            Object.assign(stages.ai as object,{
              requests,rawScope:'normalized_model_output_before_evidence_validation_latest_active_units',
              text:{raw:scoreObservations(expected,scored(rawActive)),accepted:scoreObservations(expected,scored(acceptedText)),
                returnedAcrossAttempts:requests.reduce((sum,request)=>sum+request.returned,0),acceptedCount:acceptedText.length,
                contribution:scoreContribution(expected,local,beforeVision ? scored(beforeVision) : merged)},
              vision:{status:visionCalls ? 'executed' : 'skipped',reason:visionCalls ? undefined : 'no_vision_request',parseFailures:visionParseFailures,
                raw:visionCalls ? scoreObservations(expected,scored(rawVision)) : null,
                accepted:visionCalls ? scoreObservations(expected,scored(acceptedVision)) : null,acceptedCount:acceptedVision.length,
                contribution:visionCalls ? scoreContribution(expected,beforeVision ? scored(beforeVision) : local,merged) : null},
              local:localScore,contribution:scoreContribution(expected,local,merged),
            });
          }
          activeStage = 'persistence';
          persistAiExtraction(reportId,jobId,execution.result,execution.inputCharacters);
          const stored = db.prepare(`SELECT o.id,o.item_name AS itemName,o.numeric_value AS numericValue,o.result_text AS resultText,o.unit,
            o.reference_text AS referenceText,o.reference_low AS referenceLow,o.reference_high AS referenceHigh,o.abnormal_flag AS abnormalFlag,
            o.evidence_json AS evidenceJson,ex.time_text AS timeText FROM observations o
            LEFT JOIN observation_examinations oe ON oe.observation_id=o.id LEFT JOIN report_examinations ex ON ex.id=oe.examination_id WHERE o.report_id=?`).all(reportId);
          stages.persistence = {status:'executed',score:scoreObservations(expected,stored.map(row => withEvidence(row,JSON.parse(String(row.evidenceJson))))) };
          activeStage = 'trend';
          db.prepare("UPDATE reports SET status='ready' WHERE id=?").run(reportId);
          const series = listTrendSeries({id:'eval-owner',displayName:'Synthetic evaluator',provider:'development',authenticated:true,isGatewayAdmin:false},memberId);
          const points = series.flatMap(group => group.points.map(point => {
            const original = stored.find(row=>row.id===point.observationId);
            return {...(original ? withEvidence(original,JSON.parse(String(original.evidenceJson))) : {}),...point,
              name:point.itemName,value:point.numericValue,unit:group.unit,pageNumber:point.sourcePage?.pageNumber};
          }));
          const trendExpected=expected.map(item=>({...item,...item.trendExpected}));
          const trendActual=points.map(point=>observationForScore(point));
          stages.trend = expected.every(item => typeof item.trendEligible === 'boolean')
            ? {status:'executed',score:scoreObservations(trendExpected.filter(item=>item.trendEligible),trendActual),
              admission:scoreTrendAdmission(trendExpected,trendActual)}
            : {status:'executed',scoring:'skipped',reason:'golden_has_no_trend_eligibility',extracted:points.length};
        } catch (error) {
          stages[activeStage] = {status:'failed',mode:aiMode,reason:safeCode(error)};
          if (activeStage === 'extraction') stages.ai = aiMode === 'live' && (modelCalls || visionCalls)
            ? {status:'failed',mode:aiMode,modelCalls,visionCalls,modelFailures,visionFailures,reason:safeCode(error)} : {...skipped('no_model_execution'),mode:aiMode,modelCalls,visionCalls};
          if (activeStage === 'extraction') stages.persistence = skipped('extraction_failed');
          if (activeStage !== 'trend') stages.trend = skipped(`${activeStage}_failed`);
        }
      }
      results.push(result);
    }
    writeFileSync(output,JSON.stringify(results,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({cases:results.length,expected:results.reduce((n,r)=>n+Number(r.expected),0),stage,aiMode,scoreScope:'planner',
      missing:results.reduce((n,r)=>n+Number(r.missing),0),fieldErrorItems:results.reduce((n,r)=>n+Number(r.fieldErrorItems),0)}));
  } finally { closeDatabaseForTests(); rmSync(runtime,{recursive:true,force:true}); }
}

main().catch(() => { console.error(JSON.stringify({error:'EVALUATION_FAILED'})); process.exitCode=1; });
