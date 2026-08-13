WITH base AS (
  SELECT customer_id, category, amount
  FROM `PROJECT_ID.DATASET.SALES`
),
pivoted AS (
  SELECT
    customer_id,
    COALESCE(sales_pc, 0) AS pc_sales_amount,
    COALESCE(sales_av, 0) AS av_sales_amount
  FROM base
  PIVOT (
    SUM(amount) AS sales
    FOR category
    IN ('PC' AS pc, 'AV' AS av)
  )
)
SELECT
  customer_id,
  pc_sales_amount,
  av_sales_amount
FROM pivoted
