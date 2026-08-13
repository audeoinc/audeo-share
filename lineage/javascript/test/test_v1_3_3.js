const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const sql = `
WITH base AS (
  SELECT
    s.customer_id,
    s.amount AS txn_total
  FROM project.dataset.sales AS s
),
level_2 AS (
  SELECT b.*
  FROM base AS b
),
level_3 AS (
  SELECT
    l2.*,
    RANK() OVER (ORDER BY l2.txn_total DESC) AS rank_in_all
  FROM level_2 AS l2
)
SELECT
  final.customer_id,
  final.txn_total,
  final.rank_in_all
FROM level_3 AS final
QUALIFY final.txn_total > 0
`;

const physicalColumns = [
  {
    project_id: "PROJECT",
    dataset_id: "DATASET",
    table_name: "SALES",
    column_name: "CUSTOMER_ID",
    field_path: "CUSTOMER_ID",
    ordinal_position: 1
  },
  {
    project_id: "PROJECT",
    dataset_id: "DATASET",
    table_name: "SALES",
    column_name: "AMOUNT",
    field_path: "AMOUNT",
    ordinal_position: 2
  }
];

const result = JSON.parse(bundle.analyzeLineageForBigQuery(
  sql,
  JSON.stringify(physicalColumns),
  JSON.stringify({ strict_mode: false, compact_export: true }),
  JSON.stringify({
    analysis_id: "v1_3_3_wildcard_propagation",
    view_project: "PROJECT",
    view_dataset: "DATASET",
    view_name: "TEST_WILDCARD_PROPAGATION",
    analyzed_at: "2026-07-19T00:00:00Z"
  })
));

if (result.analysis.analysis_status === "PARTIAL_FAILURE") {
  throw new Error(`analysis failed at ${result.analysis.failed_stage}`);
}

const targetNames = new Set(["CUSTOMER_ID", "TXN_TOTAL", "RANK_IN_ALL"]);
const finalReferences = result.exported_tables.column_references.filter((row) => {
  return row.scope_id === 1 && targetNames.has(row.column_name);
});

for (const name of targetNames) {
  const matching = finalReferences.filter((row) => row.column_name === name);

  if (matching.length === 0) {
    throw new Error(`${name}: final reference was not exported`);
  }

  for (const reference of matching) {
    if (reference.resolution_status !== "RESOLVED") {
      throw new Error(
        `${name}: expected RESOLVED but received ${reference.resolution_status}`
      );
    }
  }
}

const unresolvedFinalColumns = finalReferences.filter((row) => {
  return row.resolution_status !== "RESOLVED";
});

if (unresolvedFinalColumns.length > 0) {
  throw new Error(`unexpected unresolved final columns: ${JSON.stringify(unresolvedFinalColumns)}`);
}

console.log(JSON.stringify({
  name: "recursive CTE wildcard column propagation",
  status: result.analysis.analysis_status,
  finalReferences: finalReferences.map((row) => ({
    reference_name: row.reference_name,
    resolution_status: row.resolution_status
  })),
  diagnostics: result.exported_tables.diagnostics.length
}, null, 2));
