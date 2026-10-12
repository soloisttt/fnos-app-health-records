import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestWorker, stopWorker } from "../services/ocr-worker-client.ts";

test("restarts the OCR worker after a request timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-timeout-"));
  const workerScript = join(directory, "fake-worker.mjs");
  const firstRequestMarker = join(directory, "first-request-seen");
  writeFileSync(workerScript, `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(firstRequestMarker)};
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    return;
  }
  console.log(JSON.stringify({ id: request.id, ok: true, width: 12, height: 34 }));
});
`);
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = workerScript;
  process.env.OCR_WORKER_TIMEOUT_MS = "1000";
  try {
    await assert.rejects(
      () => requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" }),
      (error: unknown) => (error as { code?: string }).code === "WORKER_TIMEOUT"
    );
    assert.equal(existsSync(firstRequestMarker), true);
    const response = await requestWorker({ action: "thumbnail", imagePath: "/tmp/ignored" });
    assert.deepEqual({ ok: response.ok, width: response.width, height: response.height }, { ok: true, width: 12, height: 34 });
  } finally {
    stopWorker();
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    delete process.env.OCR_WORKER_TIMEOUT_MS;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recycles the OCR worker after the report's final OCR response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-recycle-"));
  const workerScript = join(directory, "fake-worker.mjs");
  const startupCountPath = join(directory, "startup-count");
  writeFileSync(workerScript, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const countPath = ${JSON.stringify(startupCountPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
console.log(JSON.stringify({ type: "ready", ok: true }));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: [] }));
});

`);
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = workerScript;
  try {
    const first = await requestWorker({ action: "ocr", imagePath: "/tmp/ignored" });
    const second = await requestWorker({
      action: "ocr",
      imagePath: "/tmp/ignored",
      recycleAfterResponse: true
    });
    assert.equal(Number(readFileSync(startupCountPath, "utf8")), 1);
    const nextReport = await requestWorker({
      action: "ocr",
      imagePath: "/tmp/ignored",
      recycleAfterResponse: true
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(nextReport.ok, true);
    assert.equal(Number(readFileSync(startupCountPath, "utf8")), 2);
  } finally {
    stopWorker();
    delete process.env.OCR_PYTHON_BIN;
    delete process.env.OCR_WORKER_SCRIPT;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves bounded OCR retry counts and ignores malformed metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-worker-budget-"));
  const workerScript = join(directory, "fake-worker.mjs");
  const budget = { rowCandidates: 8, rowRetried: 6, rowRemaining: 2,
    cellCandidates: 10, cellRetried: 8, cellRemaining: 2,
    imageCandidates: 4, imageRetried: 3, imageRemaining: 1 };
  const extended = { ...budget, rowUnresolved: 2, cellUnresolved: 3, imageUnresolved: 1,
    retryCalls: 24, retryCallLimit: 24, retryPixels: 20_000_000, retryPixelLimit: 24_000_000 };
  const lines = [budget, { ...budget, rowRemaining: -1 }, { ...budget, cellRemaining: 1.5 },
    { ...budget, imageRemaining: 4 }, { ...budget, imageCandidates: 1e9 },
    { ...budget, unrelated: "discard" }, extended, { ...extended, rowUnresolved: 7 },
    { ...extended, retryCalls: 25 }, { ...extended, retryPixels: 24_000_001 },
    { ...extended, retryPixels: -1 }].map((tableRetryBudget, index) => ({ id: `line-${index}`, text: "Synthetic", tableRetryBudget }));
  writeFileSync(workerScript, `
import { createInterface } from "node:readline";
console.log(JSON.stringify({ type: "ready", ok: true }));
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, ok: true, lines: ${JSON.stringify(lines)} }));
});
`);
  const previousBin = process.env.OCR_PYTHON_BIN, previousScript = process.env.OCR_WORKER_SCRIPT;
  process.env.OCR_PYTHON_BIN = process.execPath;
  process.env.OCR_WORKER_SCRIPT = workerScript;
  try {
    const response = await requestWorker({ action: "ocr", imagePath: "/tmp/synthetic" });
    assert.equal(response.lines?.length, 11);
    assert.deepEqual(response.lines?.[0].tableRetryBudget, budget);
    for (const index of [1, 2, 3, 4]) assert.equal(response.lines?.[index].tableRetryBudget, undefined);
    assert.deepEqual(response.lines?.[5].tableRetryBudget, budget);
    assert.deepEqual(response.lines?.[6].tableRetryBudget, extended);
    for (const index of [7, 8, 9, 10]) assert.equal(response.lines?.[index].tableRetryBudget, undefined);
  } finally {
    stopWorker();
    if (previousBin === undefined) delete process.env.OCR_PYTHON_BIN; else process.env.OCR_PYTHON_BIN = previousBin;
    if (previousScript === undefined) delete process.env.OCR_WORKER_SCRIPT; else process.env.OCR_WORKER_SCRIPT = previousScript;
    rmSync(directory, { recursive: true, force: true });
  }
});
