const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-047 — array element access (subscript) support.
 *
 * The expression parser only handled the OVER postfix; `base[OFFSET(n)]` /
 * `[SAFE_OFFSET(n)]` / `[ORDINAL(n)]` / `[SAFE_ORDINAL(n)]` (and a generic
 * `[expr]`) raised a parse error. Postfix subscript access is now parsed: the
 * position keyword carries no lineage, and the element value traces to the array
 * expression's source column(s); a column used inside the index is also captured.
 */

const cols = [
  { table_name: "p.d.t", column_name: "arr", field_path: "arr" },
  { table_name: "p.d.t", column_name: "idx", field_path: "idx" }
];

const metadata = {
  analysis_id: "v1_5_0_047",
  view_project: "p",
  view_dataset: "d",
  view_name: "v",
  analyzed_at: "2026-01-01T00:00:00Z"
};

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_047: " + message);
  }
}

function deps(result) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name)
    .map((p) => String(p.physical_column_name).toUpperCase()))].sort();
}

// Each position form parses and traces the element to the array's source column.
for (const sql of [
  "SELECT arr[SAFE_OFFSET(0)] AS x FROM `p.d.t`",
  "SELECT arr[OFFSET(1)] AS x FROM `p.d.t`",
  "SELECT arr[ORDINAL(2)] AS x FROM `p.d.t`",
  "SELECT arr[SAFE_ORDINAL(1)] AS x FROM `p.d.t`"
]) {
  const r = analyze(sql);
  assert(r.analysis.analysis_status === "COMPLETED",
    `should COMPLETE: ${sql} (got ${r.analysis.analysis_status})`);
  assert(JSON.stringify(deps(r)) === JSON.stringify(["ARR"]),
    `element must trace to ARR for: ${sql} (got ${JSON.stringify(deps(r))})`);
}

// A column used inside the index is also captured as a dependency.
let r = analyze("SELECT arr[SAFE_OFFSET(idx)] AS x FROM `p.d.t`");
assert(r.analysis.analysis_status === "COMPLETED", "index-column form should COMPLETE");
assert(JSON.stringify(deps(r)) === JSON.stringify(["ARR", "IDX"]),
  "index column must be captured, got " + JSON.stringify(deps(r)));

// Subscript works in a WHERE clause too.
r = analyze("SELECT idx FROM `p.d.t` WHERE arr[OFFSET(0)] = 1");
assert(r.analysis.analysis_status === "COMPLETED", "subscript in WHERE should COMPLETE");

console.log(JSON.stringify({
  test: "test_v1_5_0_047",
  status: "PASS",
  issue: "array element access base[OFFSET/SAFE_OFFSET/ORDINAL/SAFE_ORDINAL(n)] parses and traces to the array source"
}));
