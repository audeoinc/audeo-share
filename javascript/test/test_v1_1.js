const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const sql = `
SELECT
  customer_id,
  amount,
FROM project.dataset.sales
`;

const physicalColumns = [
  { table_name: "PROJECT.DATASET.SALES", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.SALES", column_name: "AMOUNT", field_path: "AMOUNT" }
];

const metadata = {
  analysis_id: "v1_1_test",
  view_project: "PROJECT",
  view_dataset: "DATASET",
  view_name: "TEST_VIEW",
  analyzed_at: "2026-07-17T00:00:00Z"
};

const result = JSON.parse(bundle.analyzeLineageForBigQuery(
  sql,
  JSON.stringify(physicalColumns),
  JSON.stringify({ strict_mode: false }),
  JSON.stringify(metadata)
));

if (!result.analysis) throw new Error("analysis object is missing");
if (Object.prototype.hasOwnProperty.call(result.exported_tables, "analyses")) {
  throw new Error("exported_tables.analyses must not exist in v1.1");
}
if (result.analysis.analysis_status === "PARTIAL_FAILURE") {
  throw new Error("Trailing comma incorrectly caused PARTIAL_FAILURE");
}
if (!Array.isArray(result.exported_tables.tokens)) throw new Error("tokens array missing");
console.log(JSON.stringify({
  status: result.analysis.analysis_status,
  tokens: result.exported_tables.tokens.length,
  diagnostics: result.exported_tables.diagnostics.length
}, null, 2));
