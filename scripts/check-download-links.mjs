// Verifies that every fixed download link of the latest release resolves (HTTP 200 after redirects).
const base = 'https://github.com/Imdlodoem23/App-to-not-Procastinate/releases/latest/download/';
const files = [
  'Centrate-Setup.exe',
  'Centrate.dmg',
  'Centrate.AppImage',
  'Centrate.deb',
  'Centrate-extension.zip',
  'SHA256SUMS.txt',
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
];
let failed = 0;
for (const file of files) {
  const res = await fetch(base + file, { method: 'HEAD', redirect: 'follow' });
  console.log(`${res.status} ${file}`);
  if (!res.ok) failed++;
}
if (failed) {
  console.error(`${failed} download link(s) are broken`);
  process.exit(1);
}
