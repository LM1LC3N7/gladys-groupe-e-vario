// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. When the Gladys
// core is cloned next to this repository (~/code/Gladys), its own manifest
// validator is run too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CALENDARS,
  CURRENCY,
  INPUT_BOUNDS,
  INPUT_DEFAULTS,
  INPUTS,
  KINDS,
  TEMPLATE_INPUTS,
  TEMPLATES,
  TIMEZONE,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

function* objects(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const value of Object.values(node)) yield* objects(value);
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider', 'no device: capabilities only');
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries needs Gladys 5.3');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
  assert.equal(manifest.keywords, undefined);
  assert.deepEqual(manifest.countries, ['CH'], 'Switzerland only (Groupe E)');
  for (const code of manifest.countries) assert.match(code, /^[A-Z]{2}$/);
});

test('one version everywhere, semver, never pinned by hand twice', () => {
  const semver = /^\d+\.\d+\.\d+$/;
  assert.match(pkg.version, semver);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-groupe-e-vario:${pkg.version}`);
  assert.match(manifest.gladys_version, /^>=\d+\.\d+\.\d+$/, 'a range, never one version');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('every text is bilingual, and the words the rules forbid are absent', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  const all = [
    'gladys-assistant-integration.json',
    'README.md',
    'docs/en.md',
    'docs/fr.md',
    'src/i18n.js',
    'CHANGELOG.md',
  ]
    .map(read)
    .join('\n');
  assert.doesNotMatch(all, /chiffr|encrypt/i);
});

test('the configuration: no key prefixed gladys_, no secret, no default on a section', () => {
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/i);
    assert.notEqual(field.type, 'secret');
    if (field.type === 'section') assert.equal(field.default, undefined);
    for (const link of field.links ?? []) assert.match(link.url, /^https:\/\//);
  }
  assert.equal(manifest.actions, undefined, 'no button');
  assert.ok(index.includes('onEnergyPrice') && index.includes('onEnergyCurrent'));
});

test('the source is named in the manifest, the docs and the notices', () => {
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  for (const lang of ['en', 'fr']) {
    assert.match(intro.description[lang], /Groupe E/);
    assert.match(intro.description[lang], /^(Unofficial|Non officiel)/);
  }
  for (const file of ['README.md', 'docs/en.md', 'docs/fr.md', 'THIRD_PARTY_NOTICES.md']) {
    const text = read(file);
    assert.match(text, /api\.tariffs\.groupe-e\.ch\/v2/, file);
  }
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.doesNotMatch(read('LICENSE'), /Copyright \d{4} [A-Z]/, 'no personal name');
});

test('the energy contract templates and calendars match the code', () => {
  const { templates, calendars } = manifest.energy_contracts;
  assert.deepEqual(
    templates.map((t) => t.key),
    KINDS.map((k) => TEMPLATES[k]),
  );
  for (const [i, kind] of KINDS.entries()) {
    const template = templates[i];
    assert.equal(template.pricing_mode, 'delegated');
    assert.equal(template.country, 'CH');
    assert.equal(template.currency, CURRENCY);
    assert.equal(template.timezone, TIMEZONE);
    assert.deepEqual(
      template.inputs.map((input) => input.key),
      TEMPLATE_INPUTS[kind],
    );
    for (const input of template.inputs) {
      assert.equal(input.type, 'number');
      assert.equal(input.default, INPUT_DEFAULTS[input.key], `${input.key} default`);
      assert.ok(INPUT_BOUNDS[input.key], `${input.key} bounds`);
      const [min, max] = INPUT_BOUNDS[input.key];
      for (const lang of ['en', 'fr']) {
        assert.ok(
          input.description[lang].includes(String(max)) ||
            input.description[lang].includes(String(max).replace('.', ',')),
          `${input.key}: the bounds are said`,
        );
      }
      assert.equal(min, 0);
    }
    assert.ok(template.tariff.components.every((c) => c.kind === 'fixed'));
    assert.equal(template.tariff.components[0].amount, `{{input:${INPUTS.FIXED}}}`);
  }
  assert.deepEqual(
    calendars.map((c) => c.key),
    KINDS.map((k) => CALENDARS[k]),
  );
  for (const calendar of calendars) {
    assert.equal(calendar.granularity, 'fifteen_minutes', 'the granularity of a key never changes');
    assert.equal(calendar.currency, CURRENCY);
    assert.equal(calendar.timezone, TIMEZONE);
    assert.equal(calendar.values, undefined, 'a price calendar');
  }
});

test('every select option follows the core rules (label, value, unique)', () => {
  // No feature here: the rule is checked on every select the manifest may carry.
  for (const node of objects(manifest)) {
    if (node.type !== 'select' || !Array.isArray(node.options)) continue;
    const values = node.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
    for (const option of node.options) {
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
    }
  }
  assert.equal(JSON.stringify(manifest).includes('supported_options'), false);
});

const core = join(homedir(), 'code/Gladys/server/lib/external-integration');
test(
  'the Gladys core validator accepts the manifest',
  { skip: !existsSync(core) && 'Gladys core not cloned' },
  async (t) => {
    // In a child process and a temporary directory: requiring the core opens
    // its database files in the working directory.
    const dir = await mkdtemp(join(tmpdir(), 'groupe-e-vario-core-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = `
      const mod = require(${JSON.stringify(join(core, 'externalIntegration.validateManifest.js'))});
      const validate = mod.validateManifest ?? mod;
      try { validate(${JSON.stringify(manifest)}); process.exit(0); }
      catch (err) { console.log('INVALID', err.message, JSON.stringify(err.properties ?? err.errors ?? '')); process.exit(3); }
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      0,
      result.stdout
        .split('\n')
        .filter((l) => /INVALID/.test(l))
        .join('\n'),
    );
  },
);

const contractValidate = join(
  homedir(),
  'code/Gladys/server/lib/energy-contract/contract.validate.js',
);
test(
  'the core takes both templates with their inputs, and refuses a negative fixed amount',
  { skip: !existsSync(contractValidate) && 'Gladys core not cloned' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'groupe-e-vario-core-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const tariff = manifest.energy_contracts.templates[1].tariff;
    const script = `
      const { validateContractTariff } = require(${JSON.stringify(contractValidate)});
      const out = {};
      for (const fixed of [0, 12.5, -8.19]) {
        try {
          validateContractTariff(${JSON.stringify(tariff)}, { energy_chf_kwh: 0.1, vat_percent: 8.1, supplement_chf_kwh: 0, fixed_chf_month: fixed }, 'delegated');
          out[fixed] = 'ok';
        } catch (err) { out[fixed] = 'refused'; }
      }
      console.log('RESULT' + JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT'));
    assert.ok(line, result.stderr);
    assert.deepEqual(JSON.parse(line.slice(6)), { 0: 'ok', 12.5: 'ok', '-8.19': 'refused' });
  },
);
