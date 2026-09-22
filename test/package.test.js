// test/package.test.js — Smoke test de ausencia de dependencias de runtime.
// Runner nativo `node --test` (Node 18+), sin dependencias npm.
//
// Cubre:
//   - package.json NO declara dependencias de runtime (clave "dependencies"
//     ausente o vacía): la feature usa solo módulos nativos de Node 18+.
//   - No hay "devDependencies" con paquetes (ausente o vacía): los tests usan
//     el runner nativo `node --test`.
//   - El script de test usa `node --test`.
//
// Validates: Requirements 14.1, 14.2, 14.3

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');

function loadPackageJson() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  // Debe ser JSON válido.
  return JSON.parse(raw);
}

test('package.json es JSON válido', () => {
  assert.doesNotThrow(loadPackageJson, 'package.json debe ser JSON parseable');
});

test('package.json no declara dependencias de runtime (Req 14.1, 14.2)', () => {
  const pkg = loadPackageJson();
  const deps = pkg.dependencies;
  const hasNoRuntimeDeps =
    deps === undefined || (deps && typeof deps === 'object' && Object.keys(deps).length === 0);
  assert.ok(
    hasNoRuntimeDeps,
    `package.json no debe declarar "dependencies" de runtime; se encontró: ${JSON.stringify(deps)}`
  );
});

test('package.json no declara devDependencies con paquetes (tests usan node --test)', () => {
  const pkg = loadPackageJson();
  const devDeps = pkg.devDependencies;
  const hasNoDevDeps =
    devDeps === undefined ||
    (devDeps && typeof devDeps === 'object' && Object.keys(devDeps).length === 0);
  assert.ok(
    hasNoDevDeps,
    `package.json no debe declarar "devDependencies" con paquetes; se encontró: ${JSON.stringify(devDeps)}`
  );
});

test('el script de test usa "node --test" (Req 14.3)', () => {
  const pkg = loadPackageJson();
  assert.ok(pkg.scripts && typeof pkg.scripts === 'object', 'package.json debe tener "scripts"');
  const testScript = pkg.scripts.test;
  assert.ok(
    typeof testScript === 'string' && testScript.includes('node --test'),
    `package.json.scripts.test debe usar "node --test"; se encontró: ${JSON.stringify(testScript)}`
  );
});
