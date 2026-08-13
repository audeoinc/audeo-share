"use strict";

const assert = require("assert");
const { LineageEngine } = require("../dist/lineage_udf_bundle.js");

function metadata(columnNames) {
  return columnNames.map((column_name, index) => ({
    project_id: "project_id",
    dataset_id: "dataset",
    table_name: "t_unpivot_source",
    column_name,
    field_path: column_name,
    ordinal_position: index + 1
  }));
}

function analyze(sql, columnNames) {
  return new LineageEngine({
    strictMode: false,
    physicalColumns: metadata(columnNames)
  }).analyze(sql);
}

function rootLineage(result, outputName) {
  return result.tables.output_lineages.find((lineage) => {
    return lineage.output_scope_id ===
        result.resolutions.sources.root_scope_id &&
      lineage.output_column_name === outputName &&
      lineage.lineage_status !== "CYCLE_DETECTED";
  });
}

function dependencyNames(lineage) {
  return [...new Set(lineage.dependencies.map((dependency) => {
    return dependency.physical_column_name;
  }))].sort();
}

const singleColumnSql = `
SELECT
  customer_id,
  metric_name,
  metric_value
FROM \`project_id.dataset.t_unpivot_source\`
UNPIVOT (
  metric_value FOR metric_name IN (
    sales_amount,
    cost_amount
  )
)
`;

const singleColumnResult = analyze(singleColumnSql, [
  "CUSTOMER_ID",
  "SALES_AMOUNT",
  "COST_AMOUNT"
]);

assert.strictEqual(singleColumnResult.analysis_status, "COMPLETED");
assert.deepStrictEqual(singleColumnResult.tables.diagnostics, []);
assert.deepStrictEqual(
  dependencyNames(rootLineage(singleColumnResult, "CUSTOMER_ID")),
  ["CUSTOMER_ID"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(singleColumnResult, "METRIC_NAME")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(singleColumnResult, "METRIC_VALUE")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);

const wildcardSql = `
SELECT *
FROM \`project_id.dataset.t_unpivot_source\`
UNPIVOT EXCLUDE NULLS (
  metric_value FOR metric_name IN (
    sales_amount,
    cost_amount
  )
)
`;

const wildcardResult = analyze(wildcardSql, [
  "CUSTOMER_ID",
  "SALES_AMOUNT",
  "COST_AMOUNT"
]);
const wildcardExpansionNames = wildcardResult.tables.wildcard_expansions
  .map((column) => column.output_column_name)
  .sort();

assert.strictEqual(wildcardResult.analysis_status, "COMPLETED");
assert.deepStrictEqual(wildcardResult.tables.diagnostics, []);
assert.deepStrictEqual(wildcardExpansionNames, ["CUSTOMER_ID"]);
assert.deepStrictEqual(
  dependencyNames(rootLineage(wildcardResult, "METRIC_NAME")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(wildcardResult, "METRIC_VALUE")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);

const derivedSql = `
WITH base AS (
  SELECT customer_id, sales_amount, cost_amount
  FROM \`project_id.dataset.t_unpivot_source\`
)
SELECT
  customer_id,
  metric_name,
  COALESCE(metric_value, 0) AS metric_value_safe
FROM base
UNPIVOT INCLUDE NULLS (
  metric_value FOR metric_name IN (
    sales_amount AS 'SALES',
    cost_amount AS 'COST'
  )
)
`;

const derivedResult = analyze(derivedSql, [
  "CUSTOMER_ID",
  "SALES_AMOUNT",
  "COST_AMOUNT"
]);

assert.strictEqual(derivedResult.analysis_status, "COMPLETED");
assert.deepStrictEqual(derivedResult.tables.diagnostics, []);
assert.deepStrictEqual(
  dependencyNames(rootLineage(derivedResult, "METRIC_NAME")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(derivedResult, "METRIC_VALUE_SAFE")),
  ["COST_AMOUNT", "SALES_AMOUNT"]
);

const multipleColumnSql = `
SELECT
  customer_id,
  quarter_name,
  sales_value,
  cost_value
FROM \`project_id.dataset.t_unpivot_source\`
UNPIVOT (
  (sales_value, cost_value)
  FOR quarter_name IN (
    (q1_sales, q1_cost) AS 'Q1',
    (q2_sales, q2_cost) AS 'Q2'
  )
)
`;

const multipleColumnResult = analyze(multipleColumnSql, [
  "CUSTOMER_ID",
  "Q1_SALES",
  "Q1_COST",
  "Q2_SALES",
  "Q2_COST"
]);

assert.strictEqual(multipleColumnResult.analysis_status, "COMPLETED");
assert.deepStrictEqual(multipleColumnResult.tables.diagnostics, []);
assert.deepStrictEqual(
  dependencyNames(rootLineage(multipleColumnResult, "SALES_VALUE")),
  ["Q1_SALES", "Q2_SALES"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(multipleColumnResult, "COST_VALUE")),
  ["Q1_COST", "Q2_COST"]
);
assert.deepStrictEqual(
  dependencyNames(rootLineage(multipleColumnResult, "QUARTER_NAME")),
  ["Q1_COST", "Q1_SALES", "Q2_COST", "Q2_SALES"]
);

console.log("test_v1_5_0_028: PASS");
