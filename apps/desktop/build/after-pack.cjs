// Ad hoc code signing for macOS builds without a Developer ID certificate.
// Without a valid signature, Apple Silicon reports unsigned apps as "damaged".
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // a real identity will sign later
  // A universal build packs x64 and arm64 into "<dir>-temp" folders and merges them;
  // @electron/universal requires identical non-binary files, and separate ad hoc
  // signatures produce different CodeResources. Sign only the merged app.
  if (context.appOutDir.endsWith('-temp')) return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
