// Signs the extension as "unlisted" on addons.mozilla.org so Firefox keeps it after a restart.
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (GitHub Secrets). Output: release/*.xpi
import { execFileSync } from 'node:child_process';

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
  console.log('AMO credentials not set: skipping Firefox signing.');
  process.exit(0);
}
execFileSync(
  'npx',
  [
    '--yes',
    'web-ext@10.7.0',
    'sign',
    '--source-dir=dist',
    '--artifacts-dir=release',
    '--channel=unlisted',
    `--api-key=${issuer}`,
    `--api-secret=${secret}`,
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
