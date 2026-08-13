WITH order_base AS (
  SELECT
    o.order_id,
    o.customer_id,
    o.order_total,
    o.order_date,
    o.status
  FROM `PROJECT_ID.DATASET.ORDERS` AS o
  WHERE o.status = 'COMPLETED'
),
payment_summary AS (
  SELECT
    p.order_id,
    SUM(p.amount) AS paid_amount,
    MAX(p.payment_date) AS last_payment_date
  FROM `PROJECT_ID.DATASET.PAYMENTS` AS p
  GROUP BY p.order_id
),
joined AS (
  SELECT
    b.order_id,
    b.customer_id,
    b.order_total,
    b.order_date,
    s.paid_amount,
    s.last_payment_date,
    b.order_total - s.paid_amount AS outstanding_amount
  FROM order_base AS b
  LEFT JOIN payment_summary AS s
    ON b.order_id = s.order_id
)
SELECT
  customer_id,
  SUM(order_total) AS gross_order_total,
  SUM(paid_amount) AS total_paid_amount,
  SUM(outstanding_amount) AS total_outstanding_amount,
  MAX(last_payment_date) AS latest_payment_date
FROM joined
GROUP BY customer_id;
