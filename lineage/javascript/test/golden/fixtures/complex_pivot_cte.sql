WITH base AS (
  SELECT customer_id, category, amount
  FROM `PROJECT_ID.DATASET.SALES`
), pivoted AS (
  SELECT * FROM base
  PIVOT (
    SUM(amount) FOR category IN ('PC' AS pc_sales, 'AV' AS av_sales)
  )
)
SELECT
  customer_id,
  pc_sales,
  av_sales,
  pc_sales + av_sales AS total_sales
FROM pivoted
