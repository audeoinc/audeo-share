WITH base AS (
  SELECT
    customer_id,
    unit_price * quantity AS gross_amount,
    internal_flag
  FROM `PROJECT_ID.DATASET.SALES_ITEMS`
)
SELECT * EXCEPT(internal_flag)
FROM base
