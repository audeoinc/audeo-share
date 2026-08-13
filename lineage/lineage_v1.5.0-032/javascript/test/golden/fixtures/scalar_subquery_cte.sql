WITH order_stats AS (
  SELECT
    customer_id,
    SUM(order_total) AS total_amount
  FROM `PROJECT_ID.DATASET.ORDERS`
  GROUP BY customer_id
)
SELECT
  (
    SELECT MAX(total_amount) AS internal_max_customer_total
    FROM order_stats
  ) AS max_customer_total;
