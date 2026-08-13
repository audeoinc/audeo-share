const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-049 — field access on a function-call result (e.g. GA4
 * `fn('key', event_params).string_value`).
 *
 * A '.' field access after a completed value expression — a function call,
 * a parenthesized expression, or an array subscript — was not handled by the
 * postfix parser (only OVER and [ ... ] were). The whole select item therefore
 * degraded to RAW_EXPRESSION, which harvested the trailing field name as a bare
 * unqualified column reference. `fn('page_location', event_params).string_value`
 * thus produced a spurious PHYSICAL_COLUMN_NOT_FOUND for STRING_VALUE (ERROR ->
 * COMPLETED_WITH_ERRORS), even though `string_value` is a nested struct field and
 * not a top-level column.
 *
 * The postfix parser now handles base.field on a call/parenthesized/subscript
 * result. Mirroring the array-subscript design (position keywords carry no
 * lineage), the accessed field selects from an opaque/derived value (the
 * function's return STRUCT) and carries NO physical-column lineage; only the base
 * expression's lineage is kept. So the output depends on the function argument
 * `event_params` (broadly, all of its collected field paths) and the trailing
 * `.string_value` no longer resolves as a column. Identifier chains like
 * `event_params.value.string_value` (a struct field path on a real column) are
 * unaffected — they are consumed before the postfix stage.
 */

const metadata = {
  analysis_id: "v1_5_0_049",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.ga", column_name: "event_params", field_path: "event_params" },
  { table_name: "p.d.ga", column_name: "event_params", field_path: "event_params.key" },
  { table_name: "p.d.ga", column_name: "event_params", field_path: "event_params.value" },
  { table_name: "p.d.ga", column_name: "event_params", field_path: "event_params.value.string_value" },
  { table_name: "p.d.ga", column_name: "event_params", field_path: "event_params.value.int_value" }
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
    throw new Error("test_v1_5_0_049: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function depFields(result) {
  return [...new Set((result.exported_tables.lineage_paths || [])
    .filter((p) => p.physical_table_name)
    .map((p) => String(p.field_path || p.physical_column_name).toUpperCase()))];
}

// 1) The core case: fn(...).string_value must not error on the trailing field.
let r = analyze(
  "SELECT myfn('page_location', event_params).string_value AS v FROM p.d.ga"
);
assert(
  r.analysis.analysis_status === "COMPLETED",
  "fn(...).string_value must be COMPLETED, got " + r.analysis.analysis_status +
  " " + JSON.stringify(errorCodes(r))
);
assert(
  !errorCodes(r).includes("PHYSICAL_COLUMN_NOT_FOUND"),
  "the trailing .string_value must not resolve as a physical column"
);

// 2) The lineage still flows from the function argument event_params.
assert(
  depFields(r).includes("EVENT_PARAMS"),
  "output must still depend on the event_params argument, got " +
  JSON.stringify(depFields(r))
);

// 3) Chained field access on a function result also parses cleanly.
r = analyze(
  "SELECT myfn('k', event_params).value.string_value AS v FROM p.d.ga"
);
assert(
  r.analysis.analysis_status === "COMPLETED",
  "fn(...).value.string_value must be COMPLETED, got " + r.analysis.analysis_status
);

// 4) Field access on a parenthesized expression result parses cleanly.
r = analyze(
  "SELECT (myfn('k', event_params)).string_value AS v FROM p.d.ga"
);
assert(
  r.analysis.analysis_status === "COMPLETED",
  "(fn(...)).string_value must be COMPLETED, got " + r.analysis.analysis_status
);

// 5) Regression: a struct field path on a real column (identifier chain) still
//    resolves to exactly that nested field.
r = analyze("SELECT event_params.value.string_value AS v FROM p.d.ga");
assert(
  r.analysis.analysis_status === "COMPLETED" &&
  depFields(r).includes("EVENT_PARAMS.VALUE.STRING_VALUE"),
  "event_params.value.string_value must resolve to the nested field, got " +
  r.analysis.analysis_status + " " + JSON.stringify(depFields(r))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_049",
  status: "PASS",
  issue: "field access on a function-call/parenthesized/subscript result " +
    "(fn('key', event_params).string_value) parses without a spurious " +
    "PHYSICAL_COLUMN_NOT_FOUND; the accessed field carries no lineage while the " +
    "function argument's lineage is preserved"
}));
