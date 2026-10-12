import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentType, feedbackUserAgent } from '../utils/deployment';
test('container deployment takes precedence over host identity, without treating local auth as Docker', () => {
  for (const mode of ['fnos','local','development','disabled'] as const) assert.equal(deploymentType(mode,true),'Docker');
  assert.equal(deploymentType('fnos',false),'fnOS');
  assert.equal(deploymentType('development',false),'Development');
  assert.equal(deploymentType('local',false),'Unknown');
  assert.equal(deploymentType('disabled',false),'Unknown');
});
test('feedback UA uses canonical product, OS and architecture names with conservative unknown values', () => {
  assert.equal(feedbackUserAgent('0.2.12','Docker','linux','arm64'),'HealthRecords/0.2.12 (Docker; Linux; aarch64)');
  assert.equal(feedbackUserAgent('0.2.12','fnOS','linux','x64'),'HealthRecords/0.2.12 (fnOS; Linux; x86_64)');
  assert.equal(feedbackUserAgent('0.2.12','Development','darwin','arm64'),'HealthRecords/0.2.12 (Development; macOS; aarch64)');
  assert.equal(feedbackUserAgent('0.2.12','Unknown','win32','ia32'),'HealthRecords/0.2.12 (Unknown; Windows; x86)');
  assert.equal(feedbackUserAgent('0.2.12','Unknown','other','other'),'HealthRecords/0.2.12 (Unknown; Unknown; Unknown)');
});
