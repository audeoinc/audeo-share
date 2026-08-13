const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * Enriched diagnostics for non-RESOLVED lineages (v1.5.0-033).
 *
 * Wildcard-expanded output columns (output_column_id = "WILDCARD_<n>") are
 * synthetic and carry no source token range, so before this change a
 * LINEAGE_PARTIALLY_RESOLVED / LINEAGE_UNRESOLVED diagnostic for such a column
 * had line_number / column_number / sql_fragment = null and no dependency
 * breakdown. Operators could not tell which part of the SQL failed.
 *
 * The resolver now:
 *   1. Falls back to the offending branch/derived scope (and finally the output
 *      scope) token range so line_number / sql_fragment / sql_context populate.
 *   2. Attaches unresolved_dependencies[] (+ scope_type / expression_text /
 *      location_basis) into the diagnostic detail, which the exporter carries in
 *      diagnostic_json (no repository DDL change required).
 */

const physicalColumns = [
  { table_name: "P.D.ORDERS", column_name: "ID", field_path: "ID" },
  { table_name: "P.D.ORDERS", column_name: "AMOUNT", field_path: "AMOUNT" },
  { table_name: "P.D.RETURNS", column_name: "ID", field_path: "ID" }
];

const metadata = {
  analysis_id: "v1_5_0_033",
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
    throw new Error("test_v1_5_0_033: " + message);
  }
}

// SELECT * over a UNION whose second branch references a column that is absent
// from the source metadata -> the wildcard-expanded AMOUNT output is
// PARTIALLY_RESOLVED, and the wildcard lineage itself has no token range.
const sql = `SELECT * FROM (
      SELECT id, amount FROM P.D.ORDERS
      UNION ALL
      SELECT id, amount FROM P.D.RETURNS
    )`;

const result = analyze(sql);
const diagnostics = result.exported_tables.diagnostics || [];

// Locate the wildcard-expanded partial-resolution diagnostic.
const wildcardDiag = diagnostics.find((row) => {
  if (row.code !== "LINEAGE_PARTIALLY_RESOLVED") {
    return false;
  }
  const detail = JSON.parse(row.diagnostic_json || "{}");
  return detail.expanded_from_wildcard === true;
});

assert(wildcardDiag, "expected a wildcard LINEAGE_PARTIALLY_RESOLVED diagnostic");

// The lineage row must genuinely be wildcard-expanded (no own token range),
// so any location has to come from the fallback, not the output column itself.
const wildcardLineage = (result.exported_tables.output_lineages || []).find(
  (row) => String(row.output_column_id).startsWith("WILDCARD_") &&
    row.lineage_status === "PARTIALLY_RESOLVED"
);
assert(wildcardLineage, "expected a WILDCARD_* PARTIALLY_RESOLVED output lineage");
assert(
  wildcardLineage.start_token_seq === null ||
  wildcardLineage.start_token_seq === undefined,
  "the wildcard lineage must have no own start_token_seq (synthetic column)"
);

// 1. Location must now be filled in via the fallback.
assert(
  wildcardDiag.line_number !== null && wildcardDiag.line_number !== undefined,
  "line_number must be populated for the wildcard diagnostic (was null before)"
);
assert(
  wildcardDiag.sql_fragment,
  "sql_fragment must be populated for the wildcard diagnostic (was null before)"
);

const detail = JSON.parse(wildcardDiag.diagnostic_json);

assert(
  ["UNRESOLVED_BRANCH_SCOPE", "OUTPUT_SCOPE"].includes(detail.location_basis),
  `location_basis must indicate a fallback, got ${detail.location_basis}`
);

// 2. Unresolved dependency breakdown must be present and point at a branch scope.
assert(
  Array.isArray(detail.unresolved_dependencies) &&
  detail.unresolved_dependencies.length >= 1,
  "unresolved_dependencies must be a non-empty array"
);
assert(
  detail.unresolved_dependency_count === detail.unresolved_dependencies.length,
  "unresolved_dependency_count must match the array length"
);

const dep = detail.unresolved_dependencies[0];
assert(
  dep.dependency_status && dep.dependency_status !== "RESOLVED",
  "the reported dependency must be non-RESOLVED"
);
assert(
  dep.branch_scope_id !== null && dep.branch_scope_id !== undefined,
  "the unresolved dependency must carry a branch_scope_id for localization"
);

// 3. The message must be self-describing (names the unresolved column).
assert(
  detail.message.includes("Unresolved:"),
  "message must include the Unresolved breakdown"
);

// 4. scope_type must be carried through for context.
assert(detail.scope_type, "scope_type must be populated on the diagnostic");

console.log(JSON.stringify({
  test: "test_v1_5_0_033",
  status: "PASS",
  issue: "Wildcard/set-operation partial-resolution diagnostics now carry SQL location (branch/scope fallback) and unresolved dependency detail"
}));
