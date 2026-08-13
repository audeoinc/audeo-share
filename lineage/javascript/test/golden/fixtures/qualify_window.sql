SELECT
  customer_id,
  order_id,
  ROW_NUMBER() OVER (
    PARTITION BY customer_id
    ORDER BY purchase_date DESC
  ) AS order_rank
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY customer_id
  ORDER BY purchase_date DESC
) = 1
