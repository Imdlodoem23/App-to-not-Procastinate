// Prints the release notes for a version: its CHANGELOG section plus download help.
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) throw new Error('usage: release-notes.mjs X.Y.Z');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
let section = '';
if (start >= 0) {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## ['));
  section = (end >= 0 ? rest.slice(0, end) : rest).join('\n').trim();
}
console.log(section || 'Mejoras y correcciones.');
console.log(`
## Descargas

| Sistema | Archivo |
|---|---|
| Windows 10 y 11 | \`Centrate-Setup.exe\` |
| macOS (Apple Silicon e Intel) | \`Centrate.dmg\` |
| Linux (Ubuntu, Debian) | \`Centrate.deb\` o \`Centrate.AppImage\` |
| Extensión del navegador | \`Centrate-extension.zip\` |

La app aún no está firmada. En Windows, si SmartScreen avisa, pulsa **Más información → Ejecutar de todas formas**. En macOS, abre **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**.

Las sumas SHA-256 están en \`SHA256SUMS.txt\`.`);
