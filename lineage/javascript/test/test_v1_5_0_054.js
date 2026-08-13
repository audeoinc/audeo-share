const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-054 — three parser gaps seen in JOBS-collected SQL:
 *
 *   1. Typed STRUCT / ARRAY constructors:
 *      STRUCT<f1 T1, f2 T2>(v1, v2), ARRAY<STRUCT<...>>[...]. The angle-bracket
 *      type list was parsed as comparisons, so it broke array literals
 *      ("expected \"]\", but found \"STRING\".") and, as a top-level SELECT item,
 *      the item was split on the comma inside <...> and the field names were
 *      harvested as columns. Fixes: STRUCT<...>(...) / ARRAY<...>[...] are parsed
 *      with the type skipped (no lineage) and the value/element lineage kept;
 *      the SELECT item splitter tracks STRUCT/ARRAY angle depth so <...> commas
 *      no longer split items (plain comparisons a < b, c > d are unaffected).
 *
 *   2. A whole query wrapped in parentheses: (SELECT ...). QueryParser reported
 *      "トップレベルのSELECT Clauseが見つかりません。" It now strips a matched
 *      outer paren pair (normalizing paren depth) and re-parses.
 *
 *   3. A tuple / row value in parentheses: (a, b) IN (SELECT ...) or (a, b) IN
 *      ((1,2),(3,4)). The parenthesized-expression parser expected ")" after the
 *      first element and failed on the comma. It now returns an EXPRESSION_LIST
 *      keeping every element's lineage.
 */

const metadata = {
  analysis_id: "v1_5_0_054",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "a", field_path: "a" },
  { table_name: "p.d.t", column_name: "b", field_path: "b" }
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
    throw new Error("test_v1_5_0_054: " + message);
  }
}

function noError(name, r) {
  const errors = (r.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR");
  assert(
    r.analysis.analysis_status !== "PARTIAL_FAILURE" && errors.length === 0,
    `${name}: expected clean parse/resolve, got ${r.analysis.analysis_status} ` +
    JSON.stringify(errors.map((d) => d.code))
  );
}

function depCols(r) {
  return [...new Set((r.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name)
    .map((p) => String(p.field_path || p.physical_column_name).toUpperCase()))];
}

// 1. Typed STRUCT / ARRAY constructors.
noError("unnest typed struct array", analyze(
  "SELECT x FROM UNNEST([STRUCT<item_id1 STRING, item_id2 STRING>('aaaa','bbbb')," +
  "('cccc','dddd')]) AS x"
));
let r = analyze("SELECT STRUCT<x INT64, y STRING>(a, b) AS s FROM p.d.t");
noError("select typed struct", r);
assert(depCols(r).includes("A") && depCols(r).includes("B") && !depCols(r).includes("X"),
  "typed STRUCT must resolve values a,b (not field names), got " +
  JSON.stringify(depCols(r)));
r = analyze("SELECT ARRAY<STRUCT<m INT64, n STRING>>[STRUCT<m INT64, n STRING>(a, b)] AS arr FROM p.d.t");
noError("typed array of struct", r);
assert(depCols(r).includes("A") && depCols(r).includes("B"),
  "typed ARRAY<STRUCT> must resolve a,b, got " + JSON.stringify(depCols(r)));

// 2. Whole query wrapped in parentheses.
r = analyze("(SELECT a FROM p.d.t)");
noError("wrapped query", r);
assert(depCols(r).includes("A"), "(SELECT a ...) must resolve a");
noError("double-wrapped query", analyze("((SELECT a, b FROM p.d.t))"));
noError("wrapped query trailing semicolon", analyze("(SELECT a FROM p.d.t);"));
// A set operation of two parenthesized queries is still split, not unwrapped.
noError("parenthesized union",
  analyze("(SELECT a FROM p.d.t) UNION ALL (SELECT b FROM p.d.t)"));

// 3. Tuple / row value in parentheses.
noError("tuple in subquery",
  analyze("SELECT a FROM p.d.t WHERE (a, b) IN (SELECT a, b FROM p.d.t)"));
noError("tuple in tuple-list",
  analyze("SELECT a FROM p.d.t WHERE (a, b) IN ((1, 2), (3, 4))"));
r = analyze("SELECT (a, b) AS s FROM p.d.t");
noError("parenthesized tuple select", r);
assert(depCols(r).includes("A") && depCols(r).includes("B"),
  "(a, b) tuple must resolve both, got " + JSON.stringify(depCols(r)));

// Regressions: a comparison list and a parenthesized arithmetic expression.
r = analyze("SELECT a < b AS lt, a > b AS gt FROM p.d.t");
noError("comparison list", r);
assert(depCols(r).includes("A") && depCols(r).includes("B"),
  "comparison items must both resolve, got " + JSON.stringify(depCols(r)));
noError("parenthesized arithmetic", analyze("SELECT (a + b) AS s FROM p.d.t"));

console.log(JSON.stringify({
  test: "test_v1_5_0_054",
  status: "PASS",
  issue: "typed STRUCT/ARRAY constructors, a whole query wrapped in parentheses, " +
    "and parenthesized tuples (a, b) IN (...) all parse and resolve"
}));
