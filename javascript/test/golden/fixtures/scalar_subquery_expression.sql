SELECT
  customer_id,
  credit_limit + (
    SELECT AVG(order_total) AS internal_avg_order_total
    FROM `PROJECT_ID.DATASET.ORDERS`
  ) AS adjusted_limit
FROM `PROJECT_ID.DATASET.CUSTOMERS`;
