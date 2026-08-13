const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

function analyze(sql, physicalColumns = []) {
  return new bundle.LineageEngine({ physicalColumns, strictMode: false }).analyze(sql);
}

// WITH RECURSIVE本文の自己参照は物理テーブルではなくCTEとして解決する。
const recursiveResult = analyze(`WITH RECURSIVE p AS (
  SELECT 1 AS n, [1] AS chain
  UNION ALL
  SELECT n + 1, ARRAY_CONCAT(p.chain, [n + 1])
  FROM p
  WHERE n < 3
)
SELECT chain FROM p`);

const recursiveSources = recursiveResult.tables.sources.filter((source) =>
  source.source_name === "P"
);
const selfReference = recursiveSources.find((source) => source.scope_id !== 1);
if (!selfReference) throw new Error("recursive self reference was not found");
if (selfReference.source_type !== "CTE") {
  throw new Error(`recursive self reference is ${selfReference.source_type}`);
}
if (selfReference.cte_query_scope_id === null) {
  throw new Error("recursive self reference has no cte_query_scope_id");
}
const metadataWarnings = recursiveResult.diagnostics.filter((diagnostic) =>
  diagnostic.diagnostic_code === "PHYSICAL_METADATA_NOT_FOUND" &&
  String(diagnostic.message).includes("P")
);
if (metadataWarnings.length !== 0) {
  throw new Error(`recursive CTE emitted metadata warnings: ${metadataWarnings.length}`);
}

// SELECT *を挟んでもSTRUCT field pathを子SELECTへ接続し、物理列まで解決する。
const structResult = analyze(`WITH all_txns AS (
  SELECT amount AS sales_amount FROM sales
),
structured_txns AS (
  SELECT *, (
    SELECT AS STRUCT sales_amount AS detail_amount
  ) AS txn_info
  FROM all_txns
),
pure_struct_txns AS (
  SELECT * EXCEPT(sales_amount)
  FROM structured_txns
),
customer_agg AS (
  SELECT SUM(t.txn_info.detail_amount) AS txn_total
  FROM pure_struct_txns AS t
)
SELECT txn_total FROM customer_agg`, [
  {
    project_name: "P",
    dataset_name: "D",
    table_name: "SALES",
    column_name: "AMOUNT",
    ordinal_position: 1
  }
]);

const txnTotal = structResult.tables.output_lineages.find((lineage) =>
  lineage.output_column_name === "TXN_TOTAL" && lineage.output_scope_id !== 1
);
if (!txnTotal) throw new Error("TXN_TOTAL lineage was not found");
const physicalAmount = txnTotal.dependencies.find((dependency) =>
  dependency.dependency_type === "PHYSICAL_COLUMN" &&
  dependency.physical_column_name === "AMOUNT"
);
if (!physicalAmount) {
  throw new Error(`TXN_TOTAL did not reach SALES.AMOUNT: ${JSON.stringify(txnTotal)}`);
}
const noDependency = txnTotal.dependencies.find((dependency) =>
  dependency.dependency_type === "DERIVED_NO_COLUMN_DEPENDENCY"
);
if (noDependency) {
  throw new Error(`TXN_TOTAL contains false NO_COLUMN_DEPENDENCY: ${JSON.stringify(noDependency)}`);
}

console.log(JSON.stringify({
  version: "1.3.9",
  tests: 2,
  recursive_cte_self_reference: "PASS",
  wildcard_struct_field_lineage: "PASS"
}, null, 2));
