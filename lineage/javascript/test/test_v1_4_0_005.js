const assert = require('assert');
const { LineageEngine } = require('../dist/lineage_udf_bundle.js');

const sql = `
WITH all_txns AS (
  SELECT customer_id, product_category, sales_amount
  FROM \`p.d.t\`
),
pivoted AS (
  SELECT *
  FROM (
    SELECT customer_id, product_category, sales_amount
    FROM all_txns
  )
  PIVOT (
    SUM(sales_amount)
    FOR product_category IN ('PC' AS pc_sales, 'AV' AS av_sales)
  )
)
SELECT pc_sales, av_sales
FROM pivoted
`;

const physicalColumns = [
  'CUSTOMER_ID',
  'PRODUCT_CATEGORY',
  'SALES_AMOUNT'
].map((column_name, index) => ({
  project_id: 'p',
  dataset_id: 'd',
  table_name: 't',
  column_name,
  field_path: column_name,
  ordinal_position: index + 1
}));

const result = new LineageEngine({ physicalColumns, strictMode: false }).analyze(sql);
assert.strictEqual(result.analysis_status, 'COMPLETED');

for (const outputName of ['PC_SALES', 'AV_SALES']) {
  const rootLineage = result.tables.output_lineages.find((item) => {
    return item.output_scope_id === 1 && item.output_column_name === outputName;
  });
  assert.ok(rootLineage, `${outputName} root lineage was not found.`);
  assert.strictEqual(rootLineage.lineage_status, 'RESOLVED');
  assert.ok(rootLineage.dependencies.some((dependency) => {
    return dependency.physical_table_name === 'P.D.T' &&
      dependency.physical_column_name === 'SALES_AMOUNT';
  }));
}

console.log('test_v1_4_0_005: PASS');
