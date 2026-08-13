const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LineageEngine } = require('../dist/lineage_udf_bundle.js');

function loadViewQuery() {
  const filePath = path.join(__dirname, 'fixtures', 'v_ec_complex_union.sql');
  const viewSql = fs.readFileSync(filePath, 'utf8');
  return viewSql.replace(/^CREATE\s+OR\s+REPLACE\s+VIEW[\s\S]*?\bAS\s*(?:\r?\n)/i, '');
}

function createPhysicalColumns() {
  const tables = {
    CUSTOMER_PURCHASE_HISTORY: [
      'ORDER_ID', 'CUSTOMER_ID', 'PRODUCT_ID', 'PURCHASE_DATE', 'UNIT_PRICE',
      'QUANTITY', 'DISCOUNT_RATE', 'PAYMENT_METHOD', 'CHANNEL', 'ORDER_STATUS'
    ],
    CUSTOMER_MASTER: ['CUSTOMER_ID', 'CUSTOMER_NAME', 'REGION', 'CUSTOMER_SEGMENT'],
    PRODUCT_MASTER: ['PRODUCT_ID', 'PRODUCT_NAME', 'CATEGORY'],
    V_EC_UNION_TRANSACTIONS: ['CUSTOMER_ID', 'AMOUNT', 'PURCHASE_DATE']
  };
  const rows = [];
  for (const [tableName, columnNames] of Object.entries(tables)) {
    columnNames.forEach((columnName, index) => {
      rows.push({
        project_id: 'PROJECT_ID',
        dataset_id: 'DATASET',
        table_name: tableName,
        column_name: columnName,
        field_path: columnName,
        ordinal_position: index + 1
      });
    });
  }
  return rows;
}

function physicalDependencies(lineage) {
  const values = (lineage.dependencies || [])
    .filter((dependency) => dependency.physical_table_name && dependency.physical_column_name)
    .map((dependency) => `${dependency.physical_table_name}.${dependency.physical_column_name}`);
  return [...new Set(values)].sort();
}

function assertExpectedDependencies(lineage, expectedDependencies, label) {
  assert.ok(lineage, `${label}: output lineage was not found.`);
  assert.strictEqual(lineage.lineage_status, 'RESOLVED', `${label}: lineage was not RESOLVED.`);
  assert.deepStrictEqual(
    physicalDependencies(lineage),
    [...expectedDependencies].sort(),
    `${label}: physical dependencies differ from the golden expectation.`
  );
}

const sql = loadViewQuery();
const expected = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'expected', 'v_ec_complex_union_lineage.json'),
  'utf8'
));
const result = new LineageEngine({
  physicalColumns: createPhysicalColumns(),
  strictMode: false
}).analyze(sql);

assert.strictEqual(result.analysis_status, 'COMPLETED');
assert.strictEqual(result.warning_count || 0, 0);
assert.strictEqual(result.error_count || 0, 0);

for (const [outputName, expectedDependencies] of Object.entries(expected.final_outputs)) {
  const lineage = result.tables.output_lineages.find((item) => {
    return item.output_scope_id === 1 && item.output_column_name === outputName;
  });
  assertExpectedDependencies(lineage, expectedDependencies, `ROOT.${outputName}`);
}

for (const [outputName, expectedDependencies] of Object.entries(expected.internal_outputs)) {
  const candidates = result.tables.output_lineages.filter((item) => {
    return item.output_column_name === outputName;
  });
  const lineage = candidates.find((item) => {
    return physicalDependencies(item).length > 0;
  });
  assertExpectedDependencies(lineage, expectedDependencies, `INTERNAL.${outputName}`);
}

// known_gaps must remain empty. A newly discovered unsupported lineage path should
// be added deliberately with a dedicated regression before being accepted here.
for (const [outputName, expectedFutureDependencies] of Object.entries(expected.known_gaps)) {
  const lineage = result.tables.output_lineages.find((item) => {
    return item.output_scope_id === 1 && item.output_column_name === outputName;
  });
  assert.ok(lineage, `KNOWN_GAP.${outputName}: output lineage was not found.`);
  assert.deepStrictEqual(physicalDependencies(lineage), []);
  assert.ok(expectedFutureDependencies.length > 0);
}

console.log(JSON.stringify({
  test: 'test_v1_5_0_002',
  status: 'PASS',
  verified_final_outputs: Object.keys(expected.final_outputs).length,
  verified_internal_outputs: Object.keys(expected.internal_outputs).length,
  known_gaps: Object.keys(expected.known_gaps)
}, null, 2));
