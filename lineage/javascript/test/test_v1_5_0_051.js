const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-051 — unquoted dashed table paths in FROM (dashed project ids).
 *
 * BigQuery allows an unquoted table path to contain hyphens, most commonly a
 * dashed project id (my-project, my-project-123). The lexer splits `my-project`
 * into `my` `-` `project`, and FromParser#parseTableSource only walked '.'-
 * separated parts, so it stopped at the first '-' and then reported
 * "FromParser: JOIN was expected, but found \"-\"." (PARTIAL_FAILURE).
 *
 * Two fixes:
 *   - FromParser now merges hyphen-joined tokens into a single path part
 *     (my - project -> MY-PROJECT), including numeric segments.
 *   - The lexer no longer swallows a '.' into a number when the '.' is followed
 *     by an identifier-start character, so `my-project-123.dataset` tokenizes as
 *     `123` `.` `dataset` (path separator) instead of `123.` `dataset`. Real
 *     float literals (1.5, 1., 1.5e3, 3.14) are unaffected.
 *
 * Backtick-quoted paths (`my-project.d.t`) already worked and still do.
 */

const metadata = {
  analysis_id: "v1_5_0_051",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "my-project.d.t", column_name: "c", field_path: "c" },
  { table_name: "my-project-123.d.t", column_name: "c", field_path: "c" },
  { table_name: "other.d.t", column_name: "c", field_path: "c" }
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
    throw new Error("test_v1_5_0_051: " + message);
  }
}

function tables(result) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name)
    .map((p) => String(p.physical_table_name).toUpperCase()))];
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

// Dashed project id resolves the source table.
let r = analyze("SELECT c FROM my-project.d.t");
noError("my-project", r);
assert(tables(r).includes("MY-PROJECT.D.T"),
  "my-project.d.t must resolve, got " + JSON.stringify(tables(r)));

// Digit-ending dashed project id (relies on the lexer dot fix).
r = analyze("SELECT c FROM my-project-123.d.t");
noError("my-project-123", r);
assert(tables(r).includes("MY-PROJECT-123.D.T"),
  "my-project-123.d.t must resolve, got " + JSON.stringify(tables(r)));

// With an alias and inside a JOIN.
r = analyze("SELECT c FROM my-project-123.d.t AS a");
noError("dashed + alias", r);
r = analyze(
  "SELECT a.c FROM my-project-123.d.t a JOIN other.d.t b ON a.c = b.c"
);
noError("dashed + join", r);

// Backtick-quoted dashed path still works.
r = analyze("SELECT c FROM `my-project-123.d.t`");
noError("backtick dashed", r);

// Regression: float literals must still tokenize as numbers, not split.
noError("float 1.5", analyze("SELECT 1.5 AS x, c FROM other.d.t"));
noError("float 1.", analyze("SELECT 1. AS x, c FROM other.d.t"));
noError("float 1.5e3", analyze("SELECT 100 * 1.5e3 AS x, c FROM other.d.t"));
noError("float 3.14", analyze("SELECT c FROM other.d.t WHERE c > 3.14"));

console.log(JSON.stringify({
  test: "test_v1_5_0_051",
  status: "PASS",
  issue: "unquoted dashed table paths in FROM (my-project / my-project-123) " +
    "parse and resolve; the lexer keeps real float literals intact"
}));
