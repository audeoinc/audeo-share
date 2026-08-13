const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const physicalColumns = [
  { table_name: "PROJECT.DATASET.CUSTOMERS", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "SALES_AMOUNT", field_path: "SALES_AMOUNT" }
];

const metadata = {
  analysis_id: "v1_5_0_018",
  view_project: "PROJECT",
  view_dataset: "DATASET",
  view_name: "TEST_VIEW",
  analyzed_at: "2026-07-22T00:00:00Z"
};

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(physicalColumns),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assertNoUnnamedOutputWarning(name, sql) {
  const result = analyze(sql);
  const warning = result.exported_tables.diagnostics.find((row) => {
    return row.code === "OUTPUT_COLUMN_NAME_UNRESOLVED";
  });

  if (warning) {
    throw new Error(`${name}: expression subquery emitted an unnamed-output warning.`);
  }

  if (result.analysis.analysis_status !== "COMPLETED") {
    throw new Error(
      `${name}: expected COMPLETED but found ${result.analysis.analysis_status}: ` +
      JSON.stringify(result.exported_tables.diagnostics)
    );
  }
}

assertNoUnnamedOutputWarning("scalar aggregate subquery", `
SELECT
  customer.customer_id,
  (
    SELECT MAX(orders.sales_amount)
    FROM project.dataset.orders AS orders
    WHERE orders.customer_id = customer.customer_id
  ) AS maximum_order_amount
FROM project.dataset.customers AS customer
`);

assertNoUnnamedOutputWarning("EXISTS subquery", `
SELECT
  customer.customer_id
FROM project.dataset.customers AS customer
WHERE EXISTS (
  SELECT 1
  FROM project.dataset.orders AS orders
  WHERE orders.customer_id = customer.customer_id
)
`);

console.log(JSON.stringify({
  test: "test_v1_5_0_018",
  status: "PASS",
  issue: "Suppress unnamed output diagnostics for expression subqueries"
}, null, 2));
