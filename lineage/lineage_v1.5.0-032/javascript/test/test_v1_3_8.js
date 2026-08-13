const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

function analyze(sql, physicalColumns = []) {
  return new bundle.LineageEngine({ physicalColumns, strictMode: false }).analyze(sql);
}

// RAW_EXPRESSION内の関数名を列参照として登録しない。
const rawResult = analyze(`SELECT ARRAY_AGG(STRUCT(order_id) ORDER BY purchase_date LIMIT 3) AS x FROM t`);
const rawNames = rawResult.tables.column_references.map((r) => r.reference_name.toUpperCase());
if (rawNames.includes("ARRAY_AGG")) throw new Error("ARRAY_AGG was collected as a column");

// UNION後続branchの無名式は先頭branchの列名を位置継承する。
const recursiveResult = analyze(`WITH RECURSIVE p AS (
  SELECT 1 AS n, [1] AS chain
  UNION ALL
  SELECT n + 1, ARRAY_CONCAT(chain, [n + 1]) FROM p WHERE n < 3
) SELECT chain FROM p`);
const unnamed = recursiveResult.diagnostics.filter((d) => d.diagnostic_code === "OUTPUT_COLUMN_NAME_UNRESOLVED");
if (unnamed.length !== 0) throw new Error(`recursive branch still has unnamed output: ${unnamed.length}`);

// alias.struct.field を alias / top-level column / field pathへ分解する。
const structResult = analyze(`WITH x AS (
  SELECT (SELECT AS STRUCT amount AS detail_amount) AS txn_info FROM sales
)
SELECT t.txn_info.detail_amount AS total FROM x AS t`, [
  { project_name: "P", dataset_name: "D", table_name: "SALES", column_name: "AMOUNT", ordinal_position: 1 }
]);
const structRef = structResult.tables.column_references.find((r) =>
  String(r.reference_name).toUpperCase() === "T.TXN_INFO.DETAIL_AMOUNT"
);
if (!structRef) throw new Error("nested field reference was not collected");
if (structRef.qualifier !== "T" || structRef.column_name !== "TXN_INFO" || structRef.field_path !== "DETAIL_AMOUNT") {
  throw new Error(`nested field split failed: ${JSON.stringify(structRef)}`);
}

const totalLineage = structResult.tables.output_lineages.find((row) => row.output_column_name === "TOTAL");
if (!totalLineage || totalLineage.lineage_status !== "RESOLVED") {
  throw new Error(`STRUCT field lineage was not resolved: ${JSON.stringify(totalLineage)}`);
}

console.log(JSON.stringify({
  version: "1.3.8",
  tests: 3,
  raw_function_filter: "PASS",
  set_operation_name_inheritance: "PASS",
  struct_field_path_split: "PASS",
  struct_field_lineage: "PASS"
}, null, 2));
