const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-050 — a string literal 'ALL' / 'DISTINCT' as the first SELECT item.
 *
 * SelectParser#removeSelectModifiers strips a leading SELECT set-quantifier
 * (SELECT [ALL|DISTINCT] ...) and the AS STRUCT / AS VALUE modifier before the
 * first item's expression is parsed. It matched on normalized_token only, so a
 * string literal whose contents spell ALL/DISTINCT (e.g. SELECT 'ALL' AS col1)
 * — token_type STRING, normalized_token "ALL" — was mistaken for the quantifier
 * and stripped, leaving the item with no expression:
 *   "SelectParser: SELECT item 1 has no expression."
 *
 * The modifier check now also requires token_type === "KEYWORD", so a quoted
 * string is never treated as a quantifier. Genuine SELECT ALL / SELECT DISTINCT /
 * SELECT AS STRUCT|VALUE are unaffected (their keywords are token_type KEYWORD).
 */

const metadata = {
  analysis_id: "v1_5_0_050",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "c", field_path: "c" }
];

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
    throw new Error("test_v1_5_0_050: " + message);
  }
}

function completed(sql) {
  const r = analyze(sql);
  assert(
    r.analysis.analysis_status !== "PARTIAL_FAILURE",
    `${sql} must parse, got ${r.analysis.analysis_status}`
  );
  return r;
}

// The reported failure: a string literal 'ALL' as the first SELECT item.
completed("SELECT 'ALL' AS col1 FROM p.d.t");
// The same for DISTINCT, and with a following real column.
completed("SELECT 'DISTINCT' AS col1 FROM p.d.t");
completed("SELECT 'ALL' AS col1, c FROM p.d.t");
// A string literal 'AS' must not be treated as the AS STRUCT/VALUE modifier.
completed("SELECT 'AS' AS col1 FROM p.d.t");

// Regression: genuine set quantifiers and AS STRUCT/VALUE still work.
let r = completed("SELECT ALL c FROM p.d.t");
assert(
  (r.exported_tables.lineage_paths || []).some(
    (p) => String(p.field_path || p.physical_column_name).toUpperCase() === "C"
  ),
  "SELECT ALL c must still resolve column c"
);
completed("SELECT DISTINCT c FROM p.d.t");
completed("SELECT AS STRUCT c AS x FROM p.d.t");

console.log(JSON.stringify({
  test: "test_v1_5_0_050",
  status: "PASS",
  issue: "a string literal 'ALL'/'DISTINCT'/'AS' as the first SELECT item is no " +
    "longer mistaken for a SELECT set-quantifier / AS STRUCT|VALUE modifier " +
    "(the modifier check now requires token_type KEYWORD)"
}));
