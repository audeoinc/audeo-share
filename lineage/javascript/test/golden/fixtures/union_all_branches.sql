SELECT
  order_id,
  unit_price * quantity AS amount
FROM `PROJECT_ID.DATASET.SALES_CURRENT`

UNION ALL

SELECT
  legacy_order_id,
  gross_amount - discount_amount
FROM `PROJECT_ID.DATASET.SALES_ARCHIVE`
