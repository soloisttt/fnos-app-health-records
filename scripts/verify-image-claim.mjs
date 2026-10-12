import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This checks image binding only. Run cosign verify-blob successfully first.
export function verifyImageClaim(claim, image, digest) {
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid expected image or digest');
  if (claim?.critical?.type !== 'cosign container image signature'
    || claim?.critical?.identity?.['docker-reference'] !== image
    || claim?.critical?.image?.['docker-manifest-digest'] !== digest) {
    throw new Error('Signed image claim does not match the expected repository and digest');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, image, digest] = process.argv.slice(2);
  verifyImageClaim(JSON.parse(readFileSync(file, 'utf8')), image, digest);
  console.log('Image repository and digest verified');
}
