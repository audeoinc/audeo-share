SELECT *
FROM (
  SELECT customer_id,
         order_total
  FROM `PROJECT_ID.DATASET.ORDERS`
)
