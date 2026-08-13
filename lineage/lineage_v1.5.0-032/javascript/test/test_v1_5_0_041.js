const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-041 — field access over UNNEST(<column>), and constant/no-physical
 * dependencies no longer reported as PARTIALLY_RESOLVED.
 *
 *  - UNNEST of a physical repeated STRUCT (GA4 event_params): ep.key /
 *    ep.value.string_value, and the no-alias bare `key`, resolve to the nested
 *    field_path (event_params.key, ...).
 *  - UNNEST of a STRUCT-literal / derived array: element fields (aaa, bbb) carry
 *    no upstream physical column, so they resolve as constants (RESOLVED, no
 *    physical edge) instead of PARTIALLY_RESOLVED — which previously propagated to
 *    downstream uses such as ROW_NUMBER() ... PARTITION BY.
 *  - Pseudo-columns / UNNEST WITH OFFSET selected as outputs are likewise
 *    resolved constants rather than UNRESOLVED.
 */

const metadata = {
  analysis_id: "v1_5_0_041",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

function analyze(sql, cols) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols || []),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_041: " + message);
  }
}

function noError(name, result) {
  const errs = (result.exported_tables.diagnostics || []).filter((d) => d.severity === "ERROR");
  assert(result.analysis.analysis_status !== "PARTIAL_FAILURE" && errs.length === 0,
    `${name}: expected no error, got ${result.analysis.analysis_status} ` +
    JSON.stringify(errs.map((d) => d.code)));
}

function noPartial(name, result) {
  const partial = (result.exported_tables.diagnostics || [])
    .filter((d) => d.code === "LINEAGE_PARTIALLY_RESOLVED" || d.code === "LINEAGE_UNRESOLVED");
  assert(partial.length === 0,
    `${name}: expected no partial/unresolved lineage, got ` +
    JSON.stringify(partial.map((d) => d.message)));
}

function deps(result, outputName) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) => String(p.output_column_name).toUpperCase() === outputName && p.physical_table_name)
    .map((p) => String(p.field_path || p.physical_column_name).toUpperCase()))];
}

// ---- GA4 event_params (physical repeated STRUCT) ----
const ev = [
  { table_name: "p.d.ev", column_name: "event_name", field_path: "event_name" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params.key" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params.value.string_value" }
];

let r = analyze("SELECT ep.key AS k FROM p.d.ev, UNNEST(event_params) AS ep", ev);
noError("ep.key", r); noPartial("ep.key", r);
assert(deps(r, "K").includes("EVENT_PARAMS.KEY"), "ep.key -> event_params.key, got " + JSON.stringify(deps(r, "K")));

r = analyze("SELECT ep.value.string_value AS v FROM p.d.ev, UNNEST(event_params) AS ep", ev);
noError("ep.value.string_value", r); noPartial("ep.value.string_value", r);
assert(deps(r, "V").includes("EVENT_PARAMS.VALUE.STRING_VALUE"),
  "deep event_params field, got " + JSON.stringify(deps(r, "V")));

r = analyze("SELECT key FROM p.d.ev, UNNEST(event_params)", ev);
noError("bare key", r); noPartial("bare key", r);
assert(deps(r, "KEY").includes("EVENT_PARAMS.KEY"), "bare key -> event_params.key, got " + JSON.stringify(deps(r, "KEY")));

// ---- STRUCT-literal array UNNEST feeding a downstream PARTITION BY ----
const xxx = [
  { table_name: "p.d.xxx", column_name: "col1", field_path: "col1" },
  { table_name: "p.d.xxx", column_name: "aaa", field_path: "aaa" }
];
r = analyze(
  "WITH cte1 AS (SELECT [STRUCT('val1' AS aaa,'seq1' AS bbb),STRUCT('val2' AS aaa,'seq3' AS bbb)] AS str),\n" +
  "cte2 AS (\n" +
  "  SELECT a.col1, b.bbb\n" +
  "  FROM p.d.xxx AS a\n" +
  "  INNER JOIN (SELECT aaa, bbb FROM cte1, UNNEST(str)) AS b ON a.aaa = b.aaa\n" +
  ")\n" +
  "SELECT col1, bbb, ROW_NUMBER() OVER (PARTITION BY bbb ORDER BY col1) AS rn FROM cte2",
  xxx
);
noError("struct-literal + PARTITION BY", r);
noPartial("struct-literal + PARTITION BY", r);
// col1 still traces to the physical column
assert(deps(r, "COL1").includes("COL1"), "col1 must still resolve, got " + JSON.stringify(deps(r, "COL1")));
// bbb is a literal -> no physical edge
assert(deps(r, "BBB").length === 0, "bbb is a constant, expected no physical dep, got " + JSON.stringify(deps(r, "BBB")));

console.log(JSON.stringify({
  test: "test_v1_5_0_041",
  status: "PASS",
  issue: "UNNEST(column) field access (GA event_params) resolves to field_path; STRUCT-literal/derived array fields resolve as constants (no false PARTIALLY_RESOLVED)"
}));
