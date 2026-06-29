/**
 * Build the full merged OpenAPI spec (same object served at /api-docs) and
 * write it to ../flutter/user/docs/openapi.json for client codegen:
 *
 *   openapi-generator-cli generate -i flutter/user/docs/openapi.json -g dart-dio -o flutter/user/generated_client
 *
 * Run via `npm run openapi` (after genOpenApi.js produces the paths).
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const spec = require('../config/swagger');

const outDir = path.join(__dirname, '..', '..', 'flutter', 'user', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'openapi.json');
fs.writeFileSync(outFile, JSON.stringify(spec, null, 2));

const count = Object.values(spec.paths || {}).reduce((n, ops) => n + Object.keys(ops).length, 0);
process.stderr.write(`Exported ${count} operations to ${outFile}\n`);
