const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-053 — EXTRACT(part FROM expr [AT TIME ZONE tz]) and WEEK(<WEEKDAY>).
 *
 * EXTRACT was not parsed as its special form. In a SELECT item it happened to
 * survive via the RAW_EXPRESSION fallback (which skips keyword tokens), but:
 *   - in a WHERE / nested context it threw
 *     "ExpressionParser: expected \")\", but found \"FROM\"." (PARTIAL_FAILURE);
 *   - identifier-typed tokens inside were mis-harvested as columns, e.g. the
 *     weekday in EXTRACT(WEEK(MONDAY) FROM dt) and the AT of AT TIME ZONE
 *     ("Column MONDAY/AT was not found" ERROR).
 * Separately, WEEK(<WEEKDAY>) as a DATE_TRUNC granularity (DATE_TRUNC(dt,
 * WEEK(MONDAY))) also mis-harvested the weekday as a column.
 *
 * EXTRACT is now parsed as EXTRACT(datepart FROM source [AT TIME ZONE tz]): the
 * datepart (incl. WEEK(<WEEKDAY>)) carries no lineage; the source expression and
 * any time-zone expression carry lineage. WEEK(<WEEKDAY>) is parsed as a
 * no-lineage date part wherever it appears.
 */

const metadata = {
  analysis_id: "v1_5_0_053",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-02T00:00:00Z"
};

const cols = [
  { table_name: "p.d.t", column_name: "dt", field_path: "dt" },
  { table_name: "p.d.t", column_name: "yyyymmdd", field_path: "yyyymmdd" },
  { table_name: "p.d.t", column_name: "tz", field_path: "tz" }
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
    throw new Error("test_v1_5_0_053: " + message);
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

// The reported parse error: EXTRACT ... FROM in a WHERE context.
noError("where extract",
  analyze("SELECT dt FROM p.d.t WHERE EXTRACT(MONTH FROM yyyymmdd) = 1"));

// EXTRACT in a SELECT item resolves the source column, not the datepart.
let r = analyze("SELECT EXTRACT(month FROM yyyymmdd) AS m, dt FROM p.d.t");
noError("select extract", r);
assert(depCols(r).includes("YYYYMMDD"),
  "EXTRACT source yyyymmdd must resolve, got " + JSON.stringify(depCols(r)));

// WEEK(<WEEKDAY>) as the datepart (reported): no MONDAY column.
r = analyze("SELECT EXTRACT(WEEK(MONDAY) FROM dt) AS w FROM p.d.t");
noError("extract week(monday)", r);
assert(!depCols(r).includes("MONDAY"),
  "WEEK(MONDAY) weekday must not resolve as a column");

// WEEK(<WEEKDAY>) as a DATE_TRUNC granularity (reported).
r = analyze("SELECT DATE_TRUNC(dt, WEEK(MONDAY)) AS w FROM p.d.t");
noError("date_trunc week(monday)", r);
assert(depCols(r).includes("DT") && !depCols(r).includes("MONDAY"),
  "DATE_TRUNC(dt, WEEK(MONDAY)) must resolve dt only, got " +
  JSON.stringify(depCols(r)));

// AT TIME ZONE: the 'AT' must not become a column; a tz column is captured.
noError("at time zone literal",
  analyze("SELECT EXTRACT(HOUR FROM dt AT TIME ZONE 'Asia/Tokyo') AS h FROM p.d.t"));
r = analyze("SELECT EXTRACT(DATE FROM dt AT TIME ZONE tz) AS d FROM p.d.t");
noError("at time zone column", r);
assert(depCols(r).includes("DT") && depCols(r).includes("TZ"),
  "AT TIME ZONE <column> must capture the tz column, got " +
  JSON.stringify(depCols(r)));

// Regression: bare dateparts as function arguments still resolve the source.
r = analyze("SELECT DATE_DIFF(dt, yyyymmdd, DAY) AS d FROM p.d.t");
noError("date_diff day", r);
assert(depCols(r).includes("DT") && depCols(r).includes("YYYYMMDD"),
  "DATE_DIFF must resolve both date columns, got " + JSON.stringify(depCols(r)));
noError("date_trunc bare week",
  analyze("SELECT DATE_TRUNC(dt, WEEK) AS w FROM p.d.t"));

console.log(JSON.stringify({
  test: "test_v1_5_0_053",
  status: "PASS",
  issue: "EXTRACT(part FROM expr [AT TIME ZONE tz]) parses with the datepart " +
    "carrying no lineage and the source/tz carrying lineage; WEEK(<WEEKDAY>) is " +
    "a no-lineage date part (no spurious MONDAY/AT column)"
}));
