SELECT * FROM (
  SELECT customer_id, category, amount
  FROM `PROJECT_ID.DATASET.SALES`
)
PIVOT (
  SUM(amount) FOR category IN ('PC' AS pc_sales, 'AV' AS av_sales)
)
