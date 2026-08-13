const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const physicalColumns = [
  { table_name: "PROJECT.DATASET.SALES", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.SALES", column_name: "SALES_AMOUNT", field_path: "SALES_AMOUNT" }
];

const metadata = {
  analysis_id: "v1_5_0_017",
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

function assertCompleted(name, sql) {
  const result = analyze(sql);

  if (result.analysis.analysis_status !== "COMPLETED") {
    throw new Error(
      `${name}: expected COMPLETED but found ${result.analysis.analysis_status}: ` +
      JSON.stringify(result.exported_tables.diagnostics)
    );
  }

  const physicalNotFound = result.exported_tables.diagnostics.find((row) => {
    return row.code === "PHYSICAL_COLUMN_NOT_FOUND";
  });

  if (physicalNotFound) {
    throw new Error(`${name}: SELECT alias was incorrectly resolved as a physical column.`);
  }
}

assertCompleted("GROUP BY output alias", `
SELECT
  customer_id AS id,
  SUM(sales_amount) AS total_sales
FROM project.dataset.sales
GROUP BY id
`);

assertCompleted("HAVING output alias", `
SELECT
  customer_id,
  SUM(sales_amount) AS total_sales
FROM project.dataset.sales
GROUP BY customer_id
HAVING total_sales > 100
`);

assertCompleted("QUALIFY output alias", `
SELECT
  customer_id,
  DENSE_RANK() OVER (ORDER BY sales_amount DESC) AS sales_rank
FROM project.dataset.sales
QUALIFY sales_rank <= 100
`);

assertCompleted("ORDER BY output alias", `
SELECT
  sales_amount AS amount
FROM project.dataset.sales
ORDER BY amount DESC
`);

const whereResult = analyze(`
SELECT
  sales_amount AS amount
FROM project.dataset.sales
WHERE amount > 0
`);

if (whereResult.analysis.analysis_status === "COMPLETED") {
  throw new Error("WHERE must not resolve a SELECT output alias.");
}

const whereDiagnostic = whereResult.exported_tables.diagnostics.find((row) => {
  return row.code === "PHYSICAL_COLUMN_NOT_FOUND";
});

if (!whereDiagnostic) {
  throw new Error("WHERE alias rejection diagnostic was not exported.");
}

console.log(JSON.stringify({
  test: "test_v1_5_0_017",
  status: "PASS",
  issue: "Shared SELECT output alias resolution for GROUP BY, HAVING, QUALIFY and ORDER BY"
}, null, 2));
