const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-037 — LIKE / NOT LIKE operator support.
 *
 * The ExpressionParser had no rule for the LIKE operator, so any predicate
 * using it (e.g. `col_b LIKE '110%'`) failed with
 *   ExpressionParser: unexpected token "LIKE"
 * which aborted source discovery (PARTIAL_FAILURE) in WHERE/JOIN clauses and,
 * in a SELECT item, mis-read LIKE as a column name (PHYSICAL_COLUMN_NOT_FOUND).
 * LIKE and NOT LIKE are now parsed as comparison expressions (and the quantified
 * LIKE ANY|SOME|ALL (...) form as an IN-style list), and LIKE is reserved so it
 * is never treated as an identifier.
 */

const physicalColumns = [
  { table_name: "P.D.T", column_name: "COL_A", field_path: "COL_A" },
  { table_name: "P.D.T", column_name: "COL_B", field_path: "COL_B" }
];

const metadata = {
  analysis_id: "v1_5_0_037",
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

function assertCompleted(name, sql) {
  const result = analyze(sql);
  if (result.analysis.analysis_status !== "COMPLETED") {
    throw new Error(
      `${name}: expected COMPLETED but got ${result.analysis.analysis_status}: ` +
      JSON.stringify((result.exported_tables.diagnostics || []).map((d) => d.code))
    );
  }
  return result;
}

// The reported field case.
assertCompleted(
  "WHERE = AND LIKE",
  "SELECT col_a FROM P.D.T WHERE col_a = 'rrrrr' AND col_b LIKE '110%'"
);

// Other clauses / forms.
assertCompleted("WHERE NOT LIKE", "SELECT col_a FROM P.D.T WHERE col_b NOT LIKE '1%'");
assertCompleted(
  "JOIN ON LIKE",
  "SELECT a.col_a FROM P.D.T a JOIN P.D.T b ON a.col_b LIKE b.col_b"
);
assertCompleted(
  "LIKE ANY quantifier",
  "SELECT col_a FROM P.D.T WHERE col_b LIKE ANY ('1%', '2%')"
);

// LIKE inside a SELECT expression must keep the column dependency and not
// treat LIKE as a column.
const selectResult = assertCompleted(
  "LIKE in SELECT",
  "SELECT col_a, (col_b LIKE '1%') AS m FROM P.D.T"
);

const bogus = (selectResult.exported_tables.diagnostics || []).find((d) =>
  d.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
  String(d.message || "").toUpperCase().includes("LIKE")
);
if (bogus) {
  throw new Error("LIKE was treated as a column: " + JSON.stringify(bogus));
}

const deps = [...new Set((selectResult.exported_tables.lineage_paths || [])
  .filter((p) =>
    String(p.output_column_name).toUpperCase() === "M" && p.physical_table_name)
  .map((p) => `${p.physical_table_name}.${p.physical_column_name}`))];
if (!deps.includes("P.D.T.COL_B")) {
  throw new Error("LIKE predicate must keep the COL_B dependency, got " + JSON.stringify(deps));
}

console.log(JSON.stringify({
  test: "test_v1_5_0_037",
  status: "PASS",
  issue: "LIKE / NOT LIKE / LIKE ANY parsing across WHERE, JOIN ON, and SELECT"
}));
