const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));
const sql = "WITH\r\ncompleted AS (\r\n  SELECT\r\n    h.order_id,\r\n    h.customer_id,\r\n    c.customer_name,\r\n    c.region,\r\n    c.customer_segment,\r\n    h.product_id,\r\n    p.product_name,\r\n    p.category AS product_category,\r\n    h.purchase_date,\r\n    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,\r\n    h.quantity,\r\n    h.payment_method,\r\n    h.channel,\r\n    h.order_status\r\n  FROM `project_id.dataset.customer_purchase_history` AS h\r\n  JOIN `project_id.dataset.customer_master` AS c\r\n    ON h.customer_id = c.customer_id\r\n  JOIN `project_id.dataset.product_master` AS p\r\n    ON h.product_id = p.product_id\r\n  WHERE LOWER(h.order_status) = 'completed'\r\n),\r\nonline AS (\r\n  SELECT * FROM completed WHERE LOWER(channel) = 'online'\r\n),\r\nstore AS (\r\n  SELECT * FROM completed WHERE LOWER(channel) IN ('store','store')\r\n),\r\n-- refunds \u306f\u91d1\u984d\u3092\u8ca0\u306b\u3057\u3066 UNION ALL \u3067\u5408\u7b97\r\nrefunds AS (\r\n  SELECT\r\n    h.order_id,\r\n    h.customer_id,\r\n    c.customer_name,\r\n    c.customer_segment,\r\n    c.region,\r\n    h.purchase_date,\r\n    -ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,\r\n    p.category AS product_category,\r\n    'refund' AS txn_type\r\n  FROM `project_id.dataset.customer_purchase_history` AS h\r\n  JOIN `project_id.dataset.customer_master` AS c\r\n    ON h.customer_id = c.customer_id\r\n  JOIN `project_id.dataset.product_master` AS p\r\n    ON h.product_id = p.product_id\r\n  WHERE LOWER(h.order_status) IN ('refunded','returned')\r\n),\r\n-- \u3053\u3053\u3067 UNION DISTINCT \u3092\u4f7f\u3063\u3066 online \u3068 store \u306e\u9867\u5ba2\u30fb\u5730\u57df\u30fb\u65e5\u4ed8\u306e\u7d44\u3092\u91cd\u8907\u9664\u5916\u3067\u7d71\u5408\r\nonline_store_union_distinct AS (\r\n  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, 'sale_online' AS txn_type\r\n  FROM online\r\n  UNION DISTINCT\r\n  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, 'sale_store' AS txn_type\r\n  FROM store\r\n),\r\n-- \u6b21\u306b UNION ALL \u3067 refunds \u3092\u542b\u3081\u305f\u5168\u30c8\u30e9\u30f3\u30b6\u30af\u30b7\u30e7\u30f3\u3092\u69cb\u6210\r\nall_txns AS (\r\n  -- \u660e\u793a\u7684\u306a\u30ab\u30e9\u30e0\u30ea\u30b9\u30c8\u3067 UNION ALL \u3092\u69cb\u6210\uff08SELECT * EXCEPT/REPLACE \u306e\u7af6\u5408\u3092\u56de\u907f\uff09\r\n  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, txn_type\r\n  FROM online_store_union_distinct\r\n  UNION ALL\r\n  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, txn_type\r\n  FROM refunds\r\n),\r\n-- \u9867\u5ba2\u5225\u306b\u8cfc\u5165\u30ab\u30c6\u30b4\u30ea\u4e00\u89a7\u3068\u8cfc\u8cb7\u56de\u6570\u30fb\u5408\u8a08\u3092\u96c6\u8a08\uff08\u76f8\u95a2\u30b9\u30ab\u30e9\u30fc\u30b5\u30d6\u30af\u30a8\u30ea\u3092\u6df7\u305c\u308b\uff09\r\ncustomer_agg AS (\r\n  SELECT\r\n    t.customer_id,\r\n    t.customer_name,\r\n    t.region,\r\n    t.customer_segment,\r\n    COUNT(1) AS txn_count,\r\n    SUM(t.sales_amount) AS txn_total,\r\n    ROUND(AVG(t.sales_amount),0) AS txn_avg,\r\n    MAX(t.purchase_date) AS last_purchase_date,\r\n    MIN(t.purchase_date) AS first_purchase_date,\r\n    -- \u76f4\u8fd13\u4ef6\u306e\u8cfc\u5165\u91d1\u984d\u306e\u5e73\u5747\u306f\u5f8c\u7d9a\u306e CTE \u3067\u7d50\u5408\u3057\u3066\u53d6\u5f97\u3059\u308b\r\n    NULL AS avg_last_3_orders,\r\n    -- ARRAY \u3092\u4f7f\u3063\u3066\u8cfc\u5165\u30ab\u30c6\u30b4\u30ea\u3092\u5217\u6319\r\n    ARRAY_TO_STRING(\r\n      ARRAY(\r\n        SELECT DISTINCT pc FROM UNNEST(\r\n          ARRAY(\r\n            SELECT product_category FROM all_txns AS a WHERE a.customer_id = t.customer_id\r\n          )\r\n        ) AS pc\r\n      ), ', '\r\n    ) AS categories_bought\r\n  FROM all_txns AS t\r\n  LEFT JOIN `project_id.dataset.customer_master` AS cm\r\n    ON t.customer_id = cm.customer_id\r\n  GROUP BY t.customer_id, t.customer_name, t.region, t.customer_segment\r\n),\r\n-- recent_avg: v_ec_union_transactions \u304b\u3089\u9867\u5ba2\u3054\u3068\u306e\u76f4\u8fd13\u4ef6\u5e73\u5747\u3092\u8a08\u7b97\r\nrecent_avg AS (\r\n  SELECT customer_id, ROUND(AVG(amount),0) AS avg_last_3_orders\r\n  FROM (\r\n    SELECT customer_id, amount, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY purchase_date DESC) AS rn\r\n    FROM `project_id.dataset.v_ec_union_transactions`\r\n  ) WHERE rn <= 3\r\n  GROUP BY customer_id\r\n),\r\n-- customer_agg \u306b recent_avg \u3092\u7d50\u5408\u3057\u3066\u6700\u7d42\u306e\u96c6\u8a08\u884c\u3092\u4f5c\u308b\r\ncustomer_agg2 AS (\r\n  SELECT\r\n    ca.customer_id,\r\n    ca.customer_name,\r\n    ca.region,\r\n    ca.customer_segment,\r\n    ca.txn_count,\r\n    ca.txn_total,\r\n    ca.txn_avg,\r\n    ca.last_purchase_date,\r\n    ca.first_purchase_date,\r\n    COALESCE(rr.avg_last_3_orders, 0) AS avg_last_3_orders,\r\n    ca.categories_bought\r\n  FROM customer_agg AS ca\r\n  LEFT JOIN recent_avg AS rr\r\n    ON ca.customer_id = rr.customer_id\r\n),\r\n-- \u30a6\u30a3\u30f3\u30c9\u30a6\u95a2\u6570: \u540c\u4e00\u5730\u57df\u5185\u3067\u306e\u9806\u4f4d\u3068\u7d2f\u7a4d\u30b7\u30a7\u30a2\u3092\u8a08\u7b97\r\ncustomer_windowed AS (\r\n  SELECT\r\n    ca2.*,\r\n    RANK() OVER (PARTITION BY ca2.region ORDER BY ca2.txn_total DESC) AS rank_in_region,\r\n    SUM(ca2.txn_total) OVER (PARTITION BY ca2.region) AS region_total_sales,\r\n    ROUND(ca2.txn_total / NULLIF(SUM(ca2.txn_total) OVER (PARTITION BY ca2.region),0) * 100,1) AS pct_of_region\r\n  FROM customer_agg2 AS ca2\r\n)\r\n\r\nSELECT\r\n  cw.customer_id,\r\n  cw.customer_name,\r\n  cw.region,\r\n  cw.customer_segment,\r\n  cw.txn_count,\r\n  cw.txn_total,\r\n  cw.txn_avg,\r\n  cw.avg_last_3_orders,\r\n  cw.categories_bought,\r\n  cw.rank_in_region,\r\n  cw.region_total_sales,\r\n  cw.pct_of_region,\r\n  CASE\r\n    WHEN cw.txn_total >= 200000 THEN 'VIP'\r\n    WHEN cw.txn_total >= 100000 THEN '\u9ad8\u984d\u9867\u5ba2'\r\n    WHEN cw.txn_count >= 5 THEN '\u983b\u7e41\u8cfc\u5165\u8005'\r\n    ELSE '\u901a\u5e38\u9867\u5ba2'\r\n  END AS customer_class\r\nFROM customer_windowed AS cw\r\n-- QUALIFY \u3092\u4f7f\u3063\u3066\u5730\u57df\u3054\u3068\u306e\u4e0a\u4f4d 5 \u9867\u5ba2\u306e\u307f\u51fa\u529b\uff08BigQuery \u306e QUALIFY\uff09\r\nQUALIFY ROW_NUMBER() OVER (PARTITION BY cw.region ORDER BY cw.txn_total DESC) <= 5";
const physicalColumns = [
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "ORDER_ID",
    "field_path": "ORDER_ID",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "CUSTOMER_ID",
    "field_path": "CUSTOMER_ID",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_MASTER",
    "column_name": "CUSTOMER_NAME",
    "field_path": "CUSTOMER_NAME",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_MASTER",
    "column_name": "REGION",
    "field_path": "REGION",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_MASTER",
    "column_name": "CUSTOMER_SEGMENT",
    "field_path": "CUSTOMER_SEGMENT",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "PRODUCT_ID",
    "field_path": "PRODUCT_ID",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "PRODUCT_MASTER",
    "column_name": "PRODUCT_NAME",
    "field_path": "PRODUCT_NAME",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "PRODUCT_MASTER",
    "column_name": "CATEGORY",
    "field_path": "CATEGORY",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "PURCHASE_DATE",
    "field_path": "PURCHASE_DATE",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "UNIT_PRICE",
    "field_path": "UNIT_PRICE",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "QUANTITY",
    "field_path": "QUANTITY",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "DISCOUNT_RATE",
    "field_path": "DISCOUNT_RATE",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "PAYMENT_METHOD",
    "field_path": "PAYMENT_METHOD",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "CHANNEL",
    "field_path": "CHANNEL",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_PURCHASE_HISTORY",
    "column_name": "ORDER_STATUS",
    "field_path": "ORDER_STATUS",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "CUSTOMER_MASTER",
    "column_name": "CUSTOMER_ID",
    "field_path": "CUSTOMER_ID",
    "ordinal_position": null
  },
  {
    "project_id": "PROJECT_ID",
    "dataset_id": "DATASET",
    "table_name": "PRODUCT_MASTER",
    "column_name": "PRODUCT_ID",
    "field_path": "PRODUCT_ID",
    "ordinal_position": null
  }
,
  {"project_id":"PROJECT_ID","dataset_id":"DATASET","table_name":"V_EC_UNION_TRANSACTIONS","column_name":"CUSTOMER_ID","field_path":"CUSTOMER_ID","ordinal_position":1},
  {"project_id":"PROJECT_ID","dataset_id":"DATASET","table_name":"V_EC_UNION_TRANSACTIONS","column_name":"AMOUNT","field_path":"AMOUNT","ordinal_position":2},
  {"project_id":"PROJECT_ID","dataset_id":"DATASET","table_name":"V_EC_UNION_TRANSACTIONS","column_name":"PURCHASE_DATE","field_path":"PURCHASE_DATE","ordinal_position":3}
];
const result = JSON.parse(bundle.analyzeLineageForBigQuery(
  sql,
  JSON.stringify(physicalColumns),
  JSON.stringify({ strict_mode: false, compact_export: true }),
  JSON.stringify({ analysis_id: "v1_3_6_complex", view_project: "PROJECT_ID", view_dataset: "DATASET", view_name: "V_EC_COMPLEX_UNION", analyzed_at: "2026-07-19T00:00:00Z" })
));
const diagnostics = result.exported_tables.diagnostics.filter((row) => row.code.startsWith("LINEAGE_"));
const subquerySource = result.exported_tables.sources.find((row) => row.source_type === "SUBQUERY");
if (!subquerySource) throw new Error("SUBQUERY source was not exported");
if (subquerySource.subquery_scope_id === null) throw new Error("subquery_scope_id was not assigned");
if (diagnostics.length !== 0) {
  throw new Error(`Expected 0 lineage diagnostics but received ${diagnostics.length}: ${diagnostics.map((row) => row.message).join(" | ")}`);
}
const avgLineage = result.exported_tables.output_lineages.find((row) =>
  row.output_scope_id === result.exported_tables.query_scopes.find((scope) => scope.scope_type === "ROOT_QUERY").scope_id &&
  row.output_column_name === "AVG_LAST_3_ORDERS"
);
if (!avgLineage || avgLineage.lineage_status !== "RESOLVED") {
  throw new Error("Final AVG_LAST_3_ORDERS lineage was not RESOLVED");
}
const avgPath = result.exported_tables.lineage_paths.find((row) =>
  row.output_column_name === "AVG_LAST_3_ORDERS" &&
  row.physical_table_name === "PROJECT_ID.DATASET.V_EC_UNION_TRANSACTIONS" &&
  row.physical_column_name === "AMOUNT"
);
if (!avgPath) {
  throw new Error("AVG_LAST_3_ORDERS did not reach V_EC_UNION_TRANSACTIONS.AMOUNT");
}
console.log(JSON.stringify({
  warning_count: result.analysis.warning_count,
  lineage_diagnostics: diagnostics.length,
  subquery_scope_id: subquerySource.subquery_scope_id,
  avg_last_3_orders_status: avgLineage.lineage_status
}, null, 2));
