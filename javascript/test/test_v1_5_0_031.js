"use strict";

const assert = require("assert");
const {
  analyzeLineageForBigQuery,
  discoverPhysicalSourcesForBigQuery
} = require("../dist/lineage_udf_bundle.js");

const sql = `
WITH customer_base AS (
  SELECT customer_id, region_id
  FROM \`project_id.dataset.customer\`
),
region_summary AS (
  SELECT region_id, region_name
  FROM dataset.region
)
SELECT
  customer.customer_id,
  region.region_name,
  (
    SELECT MAX(order_amount)
    FROM orders
    WHERE orders.customer_id = customer.customer_id
  ) AS max_order_amount
FROM customer_base AS customer
JOIN region_summary AS region
  ON customer.region_id = region.region_id
`;

const discovered = discoverPhysicalSourcesForBigQuery(sql);

assert.strictEqual(discovered.analysis.analysis_status, "COMPLETED");
assert.deepStrictEqual(
  discovered.source_tables.sort(),
  ["dataset.region", "orders", "project_id.dataset.customer"]
);

const udfResponse = JSON.parse(analyzeLineageForBigQuery(
  sql,
  "[]",
  JSON.stringify({ source_discovery_only: true }),
  null
));

assert.strictEqual(udfResponse.analysis.analysis_status, "COMPLETED");
assert.deepStrictEqual(
  udfResponse.source_tables.sort(),
  discovered.source_tables.sort()
);

console.log("v1.5.0-031 source-scoped metadata discovery: PASS");
