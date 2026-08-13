WITH base AS (
  SELECT order_id,
         amount * quantity AS gross_amount
  FROM `PROJECT_ID.DATASET.SALES_ITEMS`
)
SELECT *
FROM base
