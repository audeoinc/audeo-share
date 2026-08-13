"use strict";

const assert = require("assert");
const { LineageEngine } = require("../dist/lineage_udf_bundle.js");

const physicalColumns = [
  "CUSTOMER_ID",
  "CATEGORY",
  "AMOUNT"
].map((column_name, index) => ({
  project_id: "p",
  dataset_id: "d",
  table_name: "sales",
  column_name,
  field_path: column_name,
  ordinal_position: index + 1
}));

function analyze(sql) {
  return new LineageEngine({
    physicalColumns,
    strictMode: false
  }).analyze(sql);
}

function assertResolvedAmount(result, outputNames) {
  assert.strictEqual(result.analysis_status, "COMPLETED");
  assert.deepStrictEqual(result.tables.diagnostics, []);

  for (const outputName of outputNames) {
    const lineage = result.tables.output_lineages.find((item) => {
      return item.output_scope_id === 1 &&
        item.output_column_name === outputName;
    });

    assert.ok(lineage, `${outputName} root lineage was not found.`);
    assert.strictEqual(lineage.lineage_status, "RESOLVED");
    assert.ok(lineage.dependencies.some((dependency) => {
      return dependency.physical_table_name === "P.D.SALES" &&
        dependency.physical_column_name === "AMOUNT";
    }), `${outputName} did not resolve to P.D.SALES.AMOUNT.`);
  }
}

const singleAggregateSql = `
WITH base AS (
  SELECT customer_id, category, amount
  FROM \`p.d.sales\`
),
pivoted AS (
  SELECT
    customer_id,
    COALESCE(sales_pc, 0) AS pc_sales_amount,
    COALESCE(sales_av, 0) AS av_sales_amount
  FROM base
  PIVOT (
    SUM(amount) AS sales
    FOR category
    IN ('PC' AS pc, 'AV' AS av)
  )
)
SELECT
  customer_id,
  pc_sales_amount,
  av_sales_amount
FROM pivoted
`;

const singleAggregateResult = analyze(singleAggregateSql);
assertResolvedAmount(
  singleAggregateResult,
  ["PC_SALES_AMOUNT", "AV_SALES_AMOUNT"]
);
assert.deepStrictEqual(
  singleAggregateResult.tables.output_columns
    .filter((column) => column.output_status === "PIVOT_GENERATED")
    .map((column) => column.output_column_name),
  ["SALES_PC", "SALES_AV"]
);

const multipleAggregateSql = `
WITH base AS (
  SELECT customer_id, category, amount
  FROM \`p.d.sales\`
),
pivoted AS (
  SELECT *
  FROM base
  PIVOT (
    SUM(amount) AS total,
    MAX(amount) AS maximum
    FOR category
    IN ('PC' AS pc, 'AV' AS av)
  )
)
SELECT
  total_pc,
  maximum_pc,
  total_av,
  maximum_av
FROM pivoted
`;

const multipleAggregateResult = analyze(multipleAggregateSql);
assertResolvedAmount(
  multipleAggregateResult,
  ["TOTAL_PC", "MAXIMUM_PC", "TOTAL_AV", "MAXIMUM_AV"]
);
assert.deepStrictEqual(
  multipleAggregateResult.tables.output_columns
    .filter((column) => column.output_status === "PIVOT_GENERATED")
    .map((column) => column.output_column_name),
  ["TOTAL_PC", "MAXIMUM_PC", "TOTAL_AV", "MAXIMUM_AV"]
);

const noAggregatePrefixSql = `
WITH base AS (
  SELECT customer_id, category, amount
  FROM \`p.d.sales\`
),
pivoted AS (
  SELECT *
  FROM base
  PIVOT (
    SUM(amount)
    FOR category
    IN ('PC' AS pc, 'AV' AS av)
  )
)
SELECT pc, av
FROM pivoted
`;

assertResolvedAmount(analyze(noAggregatePrefixSql), ["PC", "AV"]);

console.log("test_v1_5_0_027: PASS");
