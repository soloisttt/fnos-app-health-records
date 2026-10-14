import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyImageClaim } from '../../../scripts/verify-image-claim.mjs';

const image = 'docker.io/example/app';
const digest = `sha256:${'a'.repeat(64)}`;
const claim = { critical: { type: 'cosign container image signature', identity: { 'docker-reference': image }, image: { 'docker-manifest-digest': digest } } };
test('signed image claim must bind both expected repository and digest', () => {
  assert.doesNotThrow(() => verifyImageClaim(claim, image, digest));
  assert.throws(() => verifyImageClaim(claim, 'docker.io/example/other', digest));
  assert.throws(() => verifyImageClaim(claim, image, `sha256:${'b'.repeat(64)}`));
  for (const invalid of [null, {}, { ...claim, critical: { ...claim.critical, type: 'other' } }]) {
    assert.throws(() => verifyImageClaim(invalid, image, digest));
  }
  assert.throws(() => verifyImageClaim(claim, image, ''));
});
