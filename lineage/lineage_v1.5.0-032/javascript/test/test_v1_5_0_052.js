const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-052 — BigQuery named query parameters @name (and @@system_variable).
 *
 * JOBS-collected SQL frequently contains named parameters, e.g. dbt-style @key
 * placeholders (WHERE dt BETWEEN @start AND @end). The lexer emits '@' as its
 * own UNKNOWN token, and the expression parser had no primary for it, so:
 *   - in an expression context it threw
 *     "ExpressionParser: token \"@\" cannot start an expression" (PARTIAL_FAILURE);
 *   - in a SELECT item it degraded to RAW_EXPRESSION and harvested the parameter
 *     name as a bare column reference (spurious PHYSICAL_COLUMN_NOT_FOUND).
 *
 * The parser now parses @name / @@name as a LITERAL_EXPRESSION (kind
 * "PARAMETER"). A parameter is an external scalar value, not a table column, so
 * it carries no lineage. The name right after '@' is consumed even when it is a
 * reserved keyword (@end, @order are valid parameter names).
 */

const metadata = {
  analysis_id: "v1_5_0_052",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "c", field_path: "c" },
  { table_name: "p.d.t", column_name: "dt", field_path: "dt" }
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
    throw new Error("test_v1_5_0_052: " + message);
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

// Parameter in a WHERE predicate (the reported case).
noError("where @key", analyze("SELECT c FROM p.d.t WHERE c = @key"));

// Parameter as a SELECT item must not become a bare column reference.
let r = analyze("SELECT @key AS x, c FROM p.d.t");
noError("select @key", r);
assert(!depCols(r).includes("KEY"),
  "@key must not resolve as a column, got " + JSON.stringify(depCols(r)));

// BETWEEN with parameters, including a reserved-word name (@end).
noError("between @start @end",
  analyze("SELECT dt FROM p.d.t WHERE dt BETWEEN @start AND @end"));
noError("reserved-name @order/@end",
  analyze("SELECT c FROM p.d.t WHERE c = @order OR dt < @end"));

// Parameter inside a function argument and IN UNNEST.
noError("func arg @fmt",
  analyze("SELECT FORMAT_DATE(@fmt, dt) AS f, c FROM p.d.t"));
noError("in unnest @ids",
  analyze("SELECT c FROM p.d.t WHERE c IN UNNEST(@ids)"));

// @@ system variable.
noError("@@ system var",
  analyze("SELECT c FROM p.d.t WHERE dt = @@my_var"));

// The real column lineage is still captured alongside the parameter.
r = analyze("SELECT c FROM p.d.t WHERE c = @key AND dt > @start");
assert(depCols(r).includes("C"),
  "column c must still resolve, got " + JSON.stringify(depCols(r)));

console.log(JSON.stringify({
  test: "test_v1_5_0_052",
  status: "PASS",
  issue: "named query parameters @name / @@name parse as no-lineage literals " +
    "(including reserved-word names like @end); real column lineage is preserved"
}));
