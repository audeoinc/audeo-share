const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-055 — named parameters whose name collides with a clause keyword.
 *
 * v1.5.0-052 added @name handling in the expression parser, but the lexer still
 * emitted '@' and the name as two tokens. When the name was a clause keyword —
 * @limit, @order, @where, @group, @from, @offset, @select — the ClauseParser saw
 * the bare keyword token and mistook that position for the start of a clause
 * (e.g. "LimitParser: body_start_seq must be an integer" for `a = @limit`).
 *
 * The lexer now reads @name / @@name as a single PARAMETER token (normalized with
 * the '@', e.g. '@LIMIT'), so it never collides with a clause keyword. The
 * expression parser consumes the PARAMETER token as a no-lineage literal.
 */

const metadata = {
  analysis_id: "v1_5_0_055",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "a", field_path: "a" },
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
    throw new Error("test_v1_5_0_055: " + message);
  }
}

function noError(name, sql) {
  const r = analyze(sql);
  const errors = (r.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR");
  assert(
    r.analysis.analysis_status !== "PARTIAL_FAILURE" && errors.length === 0,
    `${name}: expected clean parse, got ${r.analysis.analysis_status} ` +
    JSON.stringify(errors.map((d) => d.code)) + " " +
    (JSON.parse(r.analysis.error_detail_json || "{}").message || "")
  );
  return r;
}

// Parameter names that are clause keywords must not start a clause.
noError("@limit in WHERE", "SELECT a FROM p.d.t WHERE c = @key AND a = @limit");
noError("@limit as LIMIT value", "SELECT a FROM p.d.t LIMIT @limit");
noError("@limit OFFSET @offset",
  "SELECT a FROM p.d.t ORDER BY c LIMIT @limit OFFSET @offset");
// The reported "LIMIT Clause contains multiple OFFSET keywords": before the
// lexer fix, @offset split into '@' + 'offset' (an OFFSET keyword) and the
// LimitParser counted it alongside the real OFFSET.
noError("literal count + @offset", "SELECT a FROM p.d.t LIMIT 100 OFFSET @offset");
noError("@order / @group", "SELECT a FROM p.d.t WHERE c = @order OR a = @group");
noError("@where / @select", "SELECT a FROM p.d.t WHERE c = @where AND a = @select");
noError("@from / @to", "SELECT a FROM p.d.t WHERE c BETWEEN @from AND @to");
noError("@having", "SELECT a FROM p.d.t GROUP BY a HAVING COUNT(*) > @having");

// A keyword-named parameter as a SELECT item must not become a column.
let r = noError("@limit select item", "SELECT @limit AS l, a FROM p.d.t");
const cols2 = [...new Set((r.exported_tables.lineage_paths || [])
  .map((p) => String(p.field_path || p.physical_column_name).toUpperCase()))];
assert(!cols2.includes("LIMIT"),
  "@limit must not resolve as a column, got " + JSON.stringify(cols2));

// Regressions: real clauses and @@ system variables still work.
noError("real LIMIT literal", "SELECT a, c FROM p.d.t WHERE a > 5 ORDER BY c LIMIT 3");
noError("@@ system var", "SELECT a FROM p.d.t WHERE c = @@my_var");
noError("plain @key", "SELECT a FROM p.d.t WHERE c = @key");

console.log(JSON.stringify({
  test: "test_v1_5_0_055",
  status: "PASS",
  issue: "named parameters whose name is a clause keyword (@limit, @order, " +
    "@where, ...) are lexed as one PARAMETER token and no longer trigger a " +
    "spurious clause boundary"
}));
