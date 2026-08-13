const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-043 — aggregate / navigation function argument suffixes.
 *
 * `IGNORE NULLS` / `RESPECT NULLS` (and aggregate `ORDER BY` / `LIMIT`) inside a
 * function call were not parsed, so strict parsing failed and the raw fallback
 * treated `IGNORE` / `RESPECT` as a column (PHYSICAL_COLUMN_NOT_FOUND, and
 * "Unresolved: IGNORE"). The ExpressionParser now consumes these suffixes:
 * NULL treatment and LIMIT carry no lineage; ORDER BY / HAVING MAX|MIN
 * expressions are captured as dependencies.
 */

const metadata = {
  analysis_id: "v1_5_0_043",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = ["X", "G", "TS", "SEP"].map((c) => ({
  table_name: "p.d.t", column_name: c, field_path: c
}));

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
    throw new Error("test_v1_5_0_043: " + message);
  }
}

function checkClean(name, sql) {
  const r = analyze(sql);
  const errs = (r.exported_tables.diagnostics || []).filter((d) => d.severity === "ERROR");
  assert(r.analysis.analysis_status === "COMPLETED" && errs.length === 0,
    `${name}: expected COMPLETED with no errors, got ${r.analysis.analysis_status} ` +
    JSON.stringify(errs.map((d) => d.code + ":" + (String(d.message || "").match(/"([^"]+)"/) || [])[1])));
  return r;
}

function deps(r, out) {
  return [...new Set((r.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name && String(p.output_column_name).toUpperCase() === out)
    .map((p) => String(p.physical_column_name).toUpperCase()))].sort();
}

// The reported case.
let r = checkClean("ARRAY_AGG IGNORE NULLS", "SELECT ARRAY_AGG(x IGNORE NULLS) AS a FROM p.d.t");
assert(JSON.stringify(deps(r, "A")) === JSON.stringify(["X"]),
  "ARRAY_AGG IGNORE NULLS deps should be [X], got " + JSON.stringify(deps(r, "A")));

checkClean("ARRAY_AGG RESPECT NULLS", "SELECT ARRAY_AGG(x RESPECT NULLS) AS a FROM p.d.t");

// navigation function with null treatment + OVER
r = checkClean("FIRST_VALUE IGNORE NULLS OVER",
  "SELECT FIRST_VALUE(x IGNORE NULLS) OVER (PARTITION BY g ORDER BY ts) AS a FROM p.d.t");
assert(JSON.stringify(deps(r, "A")) === JSON.stringify(["G", "TS", "X"]),
  "FIRST_VALUE deps should be [G,TS,X], got " + JSON.stringify(deps(r, "A")));

// aggregate ORDER BY + LIMIT combined with null treatment
r = checkClean("ARRAY_AGG IGNORE NULLS ORDER BY LIMIT",
  "SELECT ARRAY_AGG(x IGNORE NULLS ORDER BY ts LIMIT 5) AS a FROM p.d.t");
assert(JSON.stringify(deps(r, "A")) === JSON.stringify(["TS", "X"]),
  "ARRAY_AGG ORDER BY deps should be [TS,X], got " + JSON.stringify(deps(r, "A")));

// STRING_AGG with a separator arg + ORDER BY
checkClean("STRING_AGG sep ORDER BY", "SELECT STRING_AGG(x, sep ORDER BY ts) AS a FROM p.d.t");

// DISTINCT + IGNORE NULLS together
checkClean("ARRAY_AGG DISTINCT IGNORE NULLS", "SELECT ARRAY_AGG(DISTINCT x IGNORE NULLS) AS a FROM p.d.t");

// Guard: IGNORE must not be reported as a column anywhere.
const bogus = (analyze("SELECT ARRAY_AGG(x IGNORE NULLS) AS a FROM p.d.t")
  .exported_tables.diagnostics || []).find((d) =>
  d.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
  ["IGNORE", "RESPECT", "NULLS"].includes((String(d.message || "").match(/"([^"]+)"/) || [])[1]));
assert(!bogus, "IGNORE/RESPECT/NULLS must not be treated as columns");

console.log(JSON.stringify({
  test: "test_v1_5_0_043",
  status: "PASS",
  issue: "IGNORE/RESPECT NULLS, aggregate ORDER BY/LIMIT/HAVING suffixes in function calls"
}));
