// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, without control
// bytes, and never mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and
// saved again ("é" becoming "Ã" + "©", the apostrophe "’" becoming "â€™").
// Taken from gladys-netzentgelte-14a (approved).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃÅ]|â€/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
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
  'src/constants.js',
  'src/data.js',
  'src/tariff.js',
  'src/app.js',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no control byte, no mojibake`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    assert.doesNotMatch(text, CONTROL);
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('Ã ', MOJIBAKE, 'à read as Windows-1252');
  assert.match('Å“uvre', MOJIBAKE, 'œ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » Fribourg Zürich Neuchâtel – l’app…', MOJIBAKE);
  assert.match('a\u0007b', CONTROL);
  assert.doesNotMatch('a\tb\r\n', CONTROL);
});
