WITH completed_orders AS (
  SELECT
    customer_id,
    order_id,
    order_total
  FROM `PROJECT_ID.DATASET.ORDERS`
  WHERE status = 'COMPLETED'
),
customer_metrics AS (
  SELECT
    customer_id,
    COUNT(order_id) AS order_count,
    SUM(order_total) AS lifetime_value
  FROM completed_orders
  GROUP BY customer_id
),
payment_metrics AS (
  SELECT
    o.customer_id,
    SUM(p.amount) AS total_payment_amount
  FROM completed_orders AS o
  JOIN `PROJECT_ID.DATASET.PAYMENTS` AS p
    ON o.order_id = p.order_id
  GROUP BY o.customer_id
)
SELECT
  c.customer_id,
  c.name,
  c.region,
  m.order_count,
  m.lifetime_value,
  p.total_payment_amount,
  m.lifetime_value - p.total_payment_amount AS unpaid_value
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c
LEFT JOIN customer_metrics AS m
  ON c.customer_id = m.customer_id
LEFT JOIN payment_metrics AS p
  ON c.customer_id = p.customer_id;
