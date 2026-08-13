WITH combined AS (
  SELECT order_id, amount
  FROM `PROJECT_ID.DATASET.SALES_CURRENT`
  UNION ALL
  SELECT legacy_order_id AS order_id, gross_amount AS amount
  FROM `PROJECT_ID.DATASET.SALES_ARCHIVE`
)
SELECT
  order_id,
  amount,
  (SELECT MAX(max_amount) FROM `PROJECT_ID.DATASET.LIMITS`) AS global_limit
FROM combined
