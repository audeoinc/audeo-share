const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LineageEngine } = require('../dist/lineage_udf_bundle.js');

const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'v_ec_complex_union.sql'), 'utf8');
const result = new LineageEngine({ strictMode: false }).analyze(sql);
const dayReferences = result.tables.column_references.filter((item) => item.reference_name === 'DAY');

assert.strictEqual(result.analysis_status, 'COMPLETED_WITH_WARNINGS');
assert.strictEqual(dayReferences.length, 0);
const dayDependencies = result.tables.output_lineages.filter((item) => String(item.dependencies_json || '').includes('\"source_reference_name\":\"DAY\"'));
assert.strictEqual(dayDependencies.length, 0);
console.log('test_v1_4_0_004: PASS');
