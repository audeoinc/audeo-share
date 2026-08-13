SELECT * EXCEPT(updated_at, order_total)
FROM (
  SELECT customer_id, order_total, updated_at
  FROM `PROJECT_ID.DATASET.ORDERS`
) AS q
