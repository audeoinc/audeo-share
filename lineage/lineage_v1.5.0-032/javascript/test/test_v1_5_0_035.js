const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-035 — SOURCE_METADATA_NOT_COLLECTED
 *
 * A `SELECT *` over a physical table whose column metadata was not collected
 * expands to zero columns silently (WILDCARD_NOT_EXPANDED). In a UNION this
 * surfaced far downstream as an unexplained UNRESOLVED column at the
 * SET_OPERATION scope. The resolver now emits a dedicated WARNING naming the
 * uncollected table so operators can widen the metadata collection filters.
 */

const metadata = {
  analysis_id: "v1_5_0_035",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const known = [
  { table_name: "P.D.KNOWN", column_name: "COL_A", field_path: "COL_A" },
  { table_name: "P.D.KNOWN", column_name: "KEEP1", field_path: "KEEP1" }
];

function analyze(sql, cols) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_035: " + message);
  }
}

function diagnostics(result, code) {
  return (result.exported_tables.diagnostics || []).filter((d) => d.code === code);
}

// UNION where one branch's source metadata is absent (mirrors the field case).
const unionSql =
  "WITH a AS (SELECT * FROM P.D.KNOWN)\n" +
  ", b AS (SELECT * FROM P.D.MISSING)\n" +
  ", u AS (SELECT * FROM a UNION ALL SELECT * FROM b)\n" +
  "SELECT col_a, keep1 FROM u";

const missing = analyze(unionSql, known);
const smnc = diagnostics(missing, "SOURCE_METADATA_NOT_COLLECTED");

assert(smnc.length === 1, "expected exactly one SOURCE_METADATA_NOT_COLLECTED, got " + smnc.length);
assert(smnc[0].severity === "WARNING", "SOURCE_METADATA_NOT_COLLECTED must be a WARNING");

const detail = JSON.parse(smnc[0].diagnostic_json);
const named = detail.resolved_source_name || detail.source_name;
assert(
  String(named).toUpperCase().includes("MISSING"),
  "diagnostic must name the uncollected table, got " + named
);
assert(
  smnc[0].line_number !== null && smnc[0].line_number !== undefined,
  "diagnostic must carry a line number"
);

// Direct `SELECT *` over an uncollected table also flags it.
const direct = analyze("SELECT * FROM P.D.MISSING", known);
assert(
  diagnostics(direct, "SOURCE_METADATA_NOT_COLLECTED").length === 1,
  "direct SELECT * over an uncollected table must flag SOURCE_METADATA_NOT_COLLECTED"
);

// Control: when every source's metadata is present, no such diagnostic.
const present = analyze(unionSql, known.concat([
  { table_name: "P.D.MISSING", column_name: "COL_A", field_path: "COL_A" },
  { table_name: "P.D.MISSING", column_name: "KEEP1", field_path: "KEEP1" }
]));
assert(
  diagnostics(present, "SOURCE_METADATA_NOT_COLLECTED").length === 0,
  "no SOURCE_METADATA_NOT_COLLECTED when all metadata is present"
);
assert(
  present.analysis.analysis_status === "COMPLETED",
  "control case must be COMPLETED"
);

// A collected table must never be falsely flagged.
const collectedOnly = analyze("SELECT * FROM P.D.KNOWN", known);
assert(
  diagnostics(collectedOnly, "SOURCE_METADATA_NOT_COLLECTED").length === 0,
  "a collected table must not be flagged"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_035",
  status: "PASS",
  issue: "SOURCE_METADATA_NOT_COLLECTED names the uncollected wildcard source (UNION partial-resolution root cause)"
}));
