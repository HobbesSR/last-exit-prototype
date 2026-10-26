// Writes THIRD-PARTY-NOTICES.txt from tools/third-party/components.json and the licence texts it
// names (#551). `--check` exits non-zero when the committed file differs; docs/21.1 has the process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const NOTICES_FILE = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt');
export const COMPONENTS_FILE = path.join(ROOT, 'tools/third-party/components.json');

export function readComponents() {
  return JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8'));
}

const rule = (char) => char.repeat(78);
const text = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').trimEnd();

function entry(item, depth) {
  const lines = [`${depth ? 'Includes: ' : ''}${item.name}${item.version ? ` ${item.version}` : ''}`,
    `License: ${item.license}`, `Source: ${item.source}`];
  if (item.served) lines.push(`Served as: ${item.served}`);
  if (item.textRef) lines.push(`Full licence text: see ${item.textRef} above or below.`);
  for (const file of item.texts ?? []) lines.push('', text(file));
  return lines.join('\n');
}

export function renderNotices({ audited, components } = readComponents()) {
  const sections = [
    `Last Exit third-party notices (audited ${audited})`,
    '',
    'The project\'s own code and assets are under the MIT License in LICENSE. This file lists the',
    'third-party software the server delivers to browsers, with each one\'s licence and notices;',
    'their licences are not changed by the project\'s. "dev" components are served only when',
    'developer tools are enabled. docs/21.1-third-party-licenses.md has the audit.',
  ];
  for (const delivery of ['game', 'dev']) {
    sections.push('', rule('='), delivery === 'game' ? 'Served to every client' : 'Served only with developer tools', rule('='));
    for (const component of components.filter((item) => item.delivery === delivery)) {
      sections.push('', rule('-'), entry(component, 0));
      for (const embedded of component.embeds ?? []) sections.push('', rule('.'), entry(embedded, 1));
    }
  }
  return `${sections.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderNotices();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(NOTICES_FILE) ? fs.readFileSync(NOTICES_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== rendered) {
      console.error('THIRD-PARTY-NOTICES.txt is stale; run `npm run notices`.');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(NOTICES_FILE, rendered);
    console.log(`wrote ${path.relative(ROOT, NOTICES_FILE)}`);
  }
}
