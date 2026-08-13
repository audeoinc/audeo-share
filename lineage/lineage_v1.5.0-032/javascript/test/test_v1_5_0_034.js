const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-034
 *
 * 1. `#` single-line comments (BigQuery supports both `--` and `#`). The lexer
 *    previously only recognized `--` and `/* ... *\/`, so a `#` comment between
 *    CTEs corrupted parsing.
 *
 * 2. `SELECT * EXCEPT(...)` propagation through multi-level wildcard cascades.
 *    A single `SELECT *` over an EXCEPT CTE dropped the column correctly, but a
 *    two-or-more-level `SELECT *` cascade re-expanded the underlying table
 *    without re-applying the upstream EXCEPT, so the excluded column reappeared.
 *    `#expandDerivedScopeColumns` now applies each scope's wildcard_exclusions.
 */

const physicalColumns = [
  { table_name: "P.D.TABLE_A", column_name: "COL_A", field_path: "COL_A" },
  { table_name: "P.D.TABLE_A", column_name: "COL_B", field_path: "COL_B" },
  { table_name: "P.D.TABLE_A", column_name: "KEEP1", field_path: "KEEP1" }
];

const metadata = {
  analysis_id: "v1_5_0_034",
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

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_034: " + message);
  }
}

/* The expanded column names produced by a `SELECT *` in a given scope. */
function expandedNames(result, scopeId) {
  return (result.exported_tables.output_lineages || [])
    .filter((row) =>
      row.output_scope_id === scopeId &&
      String(row.output_column_id).startsWith("WILDCARD_"))
    .map((row) => String(row.output_column_name).toUpperCase())
    .sort();
}

// --- 1. `#` comment support -------------------------------------------------
const hashResult = analyze(
  "WITH a AS ( SELECT col_a, col_b FROM P.D.TABLE_A )\n" +
  "# hash comment between CTEs\n" +
  ", b AS ( SELECT col_a, col_b FROM a )\n" +
  "SELECT col_a, col_b FROM b"
);
assert(
  hashResult.analysis.analysis_status === "COMPLETED",
  "`#` comment must not break parsing, got " + hashResult.analysis.analysis_status
);
assert(
  (hashResult.exported_tables.diagnostics || []).length === 0,
  "`#` comment case must produce no diagnostics"
);

// A `#` comment at end of a line with trailing SQL content on later lines.
const hashInline = analyze(
  "SELECT col_a  # trailing comment\n, col_b\nFROM P.D.TABLE_A"
);
assert(
  hashInline.analysis.analysis_status === "COMPLETED" &&
  (hashInline.exported_tables.diagnostics || []).length === 0,
  "inline `#` comment must be ignored cleanly"
);

// --- 2. multi-level EXCEPT cascade ------------------------------------------
// The final SELECT * cascades two levels over an EXCEPT(col_a) CTE.
const cascade = analyze(
  "WITH x_all AS ( SELECT * EXCEPT(col_a) FROM P.D.TABLE_A )\n" +
  ", x_some AS ( SELECT * FROM x_all )\n" +
  "SELECT * FROM x_some"
);
assert(
  cascade.analysis.analysis_status === "COMPLETED",
  "cascade must complete, got " + cascade.analysis.analysis_status
);

const finalScope = Math.max(
  ...(cascade.exported_tables.output_lineages || [])
    .filter((row) => String(row.output_column_id).startsWith("WILDCARD_"))
    .map((row) => row.output_scope_id)
);
const names = expandedNames(cascade, finalScope);

assert(
  !names.includes("COL_A"),
  "COL_A must stay excluded through a 2-level cascade, got [" + names.join(", ") + "]"
);
assert(
  names.includes("COL_B") && names.includes("KEEP1"),
  "non-excluded columns must remain, got [" + names.join(", ") + "]"
);

// Direct single-level EXCEPT must still work (guard against regression).
const single = analyze("SELECT * EXCEPT(col_a) FROM P.D.TABLE_A");
const singleNames = (single.exported_tables.output_lineages || [])
  .filter((row) => String(row.output_column_id).startsWith("WILDCARD_"))
  .map((row) => String(row.output_column_name).toUpperCase());
assert(
  !singleNames.includes("COL_A") && singleNames.includes("COL_B"),
  "single-level EXCEPT must still drop COL_A, got [" + singleNames.join(", ") + "]"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_034",
  status: "PASS",
  issue: "`#` single-line comments + SELECT * EXCEPT propagation through multi-level wildcard cascades"
}));
