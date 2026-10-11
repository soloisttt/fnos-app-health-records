import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticFeatures } from "../services/feedback-diagnostics-summary";

test("feedback diagnostics projects only safe OCR and AI fields", () => {
  const ocr = { available: true, installing: false, runtime: { engine: "rapidocr-onnxruntime", modelVersion: "v4", pythonVersion: "3.12.1", python: "/private/example/python", rapidocrVersion: "1.4.0", pymupdfVersion: "1.24.0" }, tableEnhancement: { tableModel: true, layoutModel: false }, runner: { started: true, busy: false, queued: 99 }, lastInstall: { logTail: ["PRIVATE_LOG"] } };
  const ai = { enabled: true, apiKeyConfigured: true, visionEnabled: false, apiKey: "PRIVATE_KEY", baseUrl: "https://private.invalid" };
  const result = diagnosticFeatures(ocr, ai);
  assert.deepEqual(result.ai, { enabled: true, visionEnabled: false });
  assert.equal(result.ocr?.engine, "rapidocr-onnxruntime");
  assert.equal(result.ocr?.tableModel, true);
  assert.equal(result.ocr?.layoutModel, false);
  assert.equal(result.ocr?.pythonVersion, "3.12.1");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private|queued|logTail|baseUrl|installing|started|busy|configured|apiKeyConfigured/);
});
test("optional service failures remain unknown rather than disabled", () => {
  assert.deepEqual(diagnosticFeatures(null, null), { ocr: null, ai: null });
});
test("unexpected paths in version fields are excluded", () => {
  const result = diagnosticFeatures({ available: false, runtime: { engine: "/private/engine", pythonVersion: "secret value" } }, null);
  assert.equal(result.ocr?.engine, null);
  assert.equal(result.ocr?.pythonVersion, null);
});
