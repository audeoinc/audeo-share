WITH base AS (
  SELECT order_id, amount, quantity
  FROM `PROJECT_ID.DATASET.SALES_ITEMS`
)
SELECT * REPLACE(amount * quantity AS amount)
FROM base
