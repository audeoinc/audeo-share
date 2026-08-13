const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

const physicalColumns = [
  { table_name: "PROJECT.DATASET.CUSTOMERS", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.SALES", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.CUSTOMERS", column_name: "ITEMS", field_path: "ITEMS" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "CUSTOMER_ID", field_path: "CUSTOMER_ID" },
  { table_name: "PROJECT.DATASET.ORDERS", column_name: "ORDER_DATE", field_path: "ORDER_DATE" }
];

const metadata = {
  analysis_id: "v1_2_test",
  view_project: "PROJECT",
  view_dataset: "DATASET",
  view_name: "TEST_VIEW",
  analyzed_at: "2026-07-17T00:00:00Z"
};

const cases = [
  {
    name: "function argument distinct modifier",
    minimumScopes: 1,
    sql: `
SELECT
  COUNT(DISTINCT s.customer_id) AS customer_count
FROM project.dataset.sales AS s
`
  },
  {
    name: "backtick qualified table name",
    minimumScopes: 1,
    sql: `
SELECT
  s.customer_id,
FROM ` + "`project.dataset.sales`" + ` AS s
`
  },
  {
    name: "array subquery inside case and array_to_string",
    sql: `
SELECT
  CASE
    WHEN c.customer_id IS NOT NULL THEN ARRAY_TO_STRING(
      ARRAY(
        SELECT item
        FROM UNNEST(c.items) AS item
      ),
      ','
    )
    ELSE ''
  END AS item_list,
FROM project.dataset.customers AS c
`
  },
  {
    name: "union distinct cte",
    minimumScopes: 3,
    sql: `
WITH combined AS (
  SELECT customer_id, amount
  FROM project.dataset.sales_online
  UNION DISTINCT
  SELECT customer_id, amount
  FROM project.dataset.sales_store
)
SELECT customer_id, amount
FROM combined
`
  },
  {
    name: "union all cte",
    minimumScopes: 3,
    sql: `
WITH combined AS (
  SELECT customer_id, amount
  FROM project.dataset.sales_online
  UNION ALL
  SELECT customer_id, amount
  FROM project.dataset.refunds
)
SELECT customer_id, amount
FROM combined
`
  },
  {
    name: "correlated scalar subquery",
    sql: `
SELECT
  c.customer_id,
  (
    SELECT MAX(o.order_date)
    FROM project.dataset.orders AS o
    WHERE o.customer_id = c.customer_id
  ) AS last_order_date,
FROM project.dataset.customers AS c
`
  }
];

for (const testCase of cases) {
  const result = JSON.parse(bundle.analyzeLineageForBigQuery(
    testCase.sql,
    JSON.stringify(physicalColumns),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify({ ...metadata, analysis_id: `v1_2_${testCase.name.replace(/\W+/g, "_")}` })
  ));

  if (!result.analysis) throw new Error(`${testCase.name}: analysis missing`);

  if (testCase.name === "function argument distinct modifier") {
    const queryAst = JSON.parse(result.analysis.query_ast_json);
    const expression = queryAst.select[0].expression;

    if (expression !== "COUNT(DISTINCT s.customer_id)") {
      throw new Error(`${testCase.name}: unexpected expression text: ${expression}`);
    }
  }

  if (testCase.name === "union distinct cte" || testCase.name === "union all cte") {
    const queryAst = JSON.parse(result.analysis.query_ast_json);
    const cteQuery = queryAst.common_table_expressions[0].query;
    const operation = cteQuery.set_operations[0];
    const expectedModifier = testCase.name.includes("distinct") ? "DISTINCT" : "ALL";

    if (!operation || operation.operator !== "UNION") {
      throw new Error(`${testCase.name}: UNION AST was not created`);
    }

    if (operation.modifier !== expectedModifier) {
      throw new Error(`${testCase.name}: unexpected modifier ${operation.modifier}`);
    }
  }
  if (result.analysis.analysis_status === "PARTIAL_FAILURE") {
    throw new Error(`${testCase.name}: ${result.analysis.failed_stage || "unknown stage"}`);
  }

  const scopes = result.exported_tables.query_scopes || [];
  const minimumScopes = testCase.minimumScopes || 2;
  if (scopes.length < minimumScopes) {
    throw new Error(`${testCase.name}: expected at least ${minimumScopes} query scope(s)`);
  }

  console.log(JSON.stringify({
    name: testCase.name,
    status: result.analysis.analysis_status,
    scopes: scopes.length,
    sources: result.exported_tables.sources.length,
    columnReferences: result.exported_tables.column_references.length,
    diagnostics: result.exported_tables.diagnostics.length
  }, null, 2));
}
