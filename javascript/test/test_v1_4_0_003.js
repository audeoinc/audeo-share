const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LineageEngine } = require('../dist/lineage_udf_bundle.js');

const sqlFile = path.join(__dirname, 'fixtures', 'v_ec_complex_union.sql');
const sqlText = fs.readFileSync(sqlFile, 'utf8');

const engineResult = new LineageEngine({ strictMode: false }).analyze(sqlText);

assert.notStrictEqual(engineResult.analysis_status, 'PARTIAL_FAILURE');
assert.notStrictEqual(engineResult.analysis_status, 'FAILED');
assert.strictEqual(engineResult.failed_stage, null);
assert.ok(engineResult.query_ast);
assert.ok(engineResult.tables.output_columns.length > 0);
assert.ok(engineResult.tables.sources.length > 0);
assert.ok(!engineResult.diagnostics.some((item) => item.severity === 'ERROR'));

console.log('test_v1_4_0_003: PASS');
console.log(JSON.stringify({
  analysis_status: engineResult.analysis_status,
  warning_count: engineResult.diagnostics.filter((item) => item.severity === 'WARNING').length,
  source_count: engineResult.tables.sources.length,
  output_column_count: engineResult.tables.output_columns.length
}, null, 2));
