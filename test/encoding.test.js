// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). None of
// them says that a secret is encrypted: Gladys keeps it in its database. And
// no file of the repository holds a control byte (but tab, LF and CR).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, never "encrypted"`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
    assert.doesNotMatch(text, /chiffr|encrypt/i, `${file} says encrypted`);
  });
}

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});

/** Every text file of the repository (dependencies and git aside). */
function* textFiles(dir = new URL('../', import.meta.url), path = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      yield* textFiles(url, `${path}${entry.name}/`);
    } else if (!/\.(png|jpg|ico)$/i.test(entry.name)) {
      yield [`${path}${entry.name}`, url];
    }
  }
}

test('no control byte in any file (but tab, LF and CR), no BOM in the code', () => {
  for (const [name, url] of textFiles()) {
    const bytes = readFileSync(url);
    const bad = bytes.findIndex(
      (b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f,
    );
    assert.equal(bad, -1, `${name}: control byte at ${bad}`);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}: BOM`);
  }
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /Copyright \(c\) 2018 Jacob Southard/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /lennoxs30api/);
  assert.match(notices, /gladys-testkit/);
});
