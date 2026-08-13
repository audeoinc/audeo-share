SELECT
  c.customer_id,
  c.credit_limit + (
    SELECT AVG(o.order_total) AS internal_avg_order_total
    FROM `PROJECT_ID.DATASET.ORDERS` AS o
    WHERE o.customer_id = c.customer_id
  ) AS adjusted_limit
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c;
