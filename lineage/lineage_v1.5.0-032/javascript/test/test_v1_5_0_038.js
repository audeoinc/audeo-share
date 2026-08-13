const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-038 — coverage for common BigQuery constructs surfaced by a parser
 * sweep. Each previously failed with PARTIAL_FAILURE (parse abort), a spurious
 * PHYSICAL_COLUMN_NOT_FOUND (keyword mis-read as a column), or a hard ERROR.
 *
 *   - typed literals: DATE/TIMESTAMP/DATETIME/NUMERIC '...'
 *   - INTERVAL n UNIT (and INTERVAL col UNIT keeps the column dependency)
 *   - raw / bytes string literals: r'...', b'...'
 *   - scientific-notation numbers: 1.5e3
 *   - x IN UNNEST(array)
 *   - INTERSECT / EXCEPT set operators (vs SELECT * EXCEPT(...))
 *   - UNNEST ... WITH OFFSET
 *   - named WINDOW clause
 *   - TABLESAMPLE
 *   - the UNNEST value column no longer raises a hard ERROR
 */

const physicalColumns = [
  { table_name: "P.D.T", column_name: "ID", field_path: "ID" },
  { table_name: "P.D.T", column_name: "NAME", field_path: "NAME" },
  { table_name: "P.D.T", column_name: "TS", field_path: "TS" },
  { table_name: "P.D.T", column_name: "DT", field_path: "DT" },
  { table_name: "P.D.T", column_name: "AMT", field_path: "AMT" },
  { table_name: "P.D.T", column_name: "ARR", field_path: "ARR" },
  { table_name: "P.D.T", column_name: "CAT", field_path: "CAT" },
  { table_name: "P.D.T", column_name: "QTY", field_path: "QTY" }
];

const metadata = {
  analysis_id: "v1_5_0_038",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(physicalColumns),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function diagCodes(result) {
  return (result.exported_tables.diagnostics || []).map((d) => `${d.severity}:${d.code}`);
}

// No parse abort and no ERROR-severity diagnostics.
function assertClean(name, sql) {
  const result = analyze(sql);
  const status = result.analysis.analysis_status;
  const errors = (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR");

  if (status === "PARTIAL_FAILURE" || status === "COMPLETED_WITH_ERRORS" || errors.length) {
    throw new Error(
      `test_v1_5_0_038 [${name}]: expected a clean parse/analyze, got ${status} ` +
      JSON.stringify(diagCodes(result))
    );
  }
  return result;
}

assertClean("DATE literal", "SELECT id FROM P.D.T WHERE dt > DATE '2020-01-01'");
assertClean("TIMESTAMP literal", "SELECT id FROM P.D.T WHERE ts > TIMESTAMP '2020-01-01 00:00:00'");
assertClean("NUMERIC literal", "SELECT id FROM P.D.T WHERE amt > NUMERIC '1.5'");
assertClean("INTERVAL n unit", "SELECT DATE_ADD(dt, INTERVAL 1 DAY) AS d FROM P.D.T");
assertClean("raw string", "SELECT id FROM P.D.T WHERE REGEXP_CONTAINS(name, r'^A')");
assertClean("bytes string", "SELECT id FROM P.D.T WHERE name = b'abc'");
assertClean("scientific notation", "SELECT id FROM P.D.T WHERE amt > 1.5e3");
assertClean("IN UNNEST", "SELECT id FROM P.D.T WHERE id IN UNNEST(arr)");
assertClean("INTERSECT DISTINCT", "SELECT id FROM P.D.T INTERSECT DISTINCT SELECT id FROM P.D.T");
assertClean("EXCEPT set op", "SELECT id FROM P.D.T EXCEPT DISTINCT SELECT id FROM P.D.T");
assertClean("SELECT * EXCEPT still works", "SELECT * EXCEPT(id) FROM P.D.T");
assertClean("UNNEST WITH OFFSET", "SELECT v, off FROM P.D.T, UNNEST(arr) AS v WITH OFFSET AS off");
assertClean("named WINDOW clause", "SELECT SUM(amt) OVER w AS s FROM P.D.T WINDOW w AS (PARTITION BY cat)");
assertClean("TABLESAMPLE", "SELECT id FROM P.D.T TABLESAMPLE SYSTEM (10 PERCENT)");

// INTERVAL over a column must keep the column dependency.
const interval = assertClean(
  "INTERVAL col unit",
  "SELECT TIMESTAMP_SUB(ts, INTERVAL qty HOUR) AS d FROM P.D.T"
);
const dDeps = [...new Set((interval.exported_tables.lineage_paths || [])
  .filter((p) => String(p.output_column_name).toUpperCase() === "D" && p.physical_table_name)
  .map((p) => `${p.physical_table_name}.${p.physical_column_name}`))];
if (!dDeps.includes("P.D.T.TS") || !dDeps.includes("P.D.T.QTY")) {
  throw new Error("test_v1_5_0_038 [INTERVAL col]: expected TS and QTY deps, got " + JSON.stringify(dDeps));
}

// The UNNEST value column used to raise a hard ERROR; it must now be clean
// (a LINEAGE warning is acceptable, an ERROR is not).
const unnest = analyze("SELECT v FROM P.D.T, UNNEST(arr) AS v");
if ((unnest.exported_tables.diagnostics || []).some((d) => d.severity === "ERROR")) {
  throw new Error("test_v1_5_0_038 [UNNEST value]: must not raise an ERROR, got " + JSON.stringify(diagCodes(unnest)));
}

console.log(JSON.stringify({
  test: "test_v1_5_0_038",
  status: "PASS",
  issue: "Typed literals, INTERVAL, raw/bytes strings, scientific notation, IN UNNEST, INTERSECT/EXCEPT, WITH OFFSET, WINDOW, TABLESAMPLE, UNNEST value"
}));
