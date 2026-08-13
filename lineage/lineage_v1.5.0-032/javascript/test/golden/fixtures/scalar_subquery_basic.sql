SELECT
  customer_id,
  (
    SELECT MAX(order_total) AS internal_max_order_total
    FROM `PROJECT_ID.DATASET.ORDERS`
  ) AS max_order_total
FROM `PROJECT_ID.DATASET.CUSTOMERS`;
