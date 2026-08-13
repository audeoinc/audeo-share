WITH changed_orders AS (
  SELECT
    order_id,
    customer_id,
    order_total,
    order_date,
    status
  FROM `PROJECT_ID.DATASET.ORDERS`
  WHERE order_date >= '2026-07-13'
),
ranked_orders AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY order_id
      ORDER BY order_date DESC
    ) AS row_num
  FROM changed_orders
),
latest_orders AS (
  SELECT * EXCEPT(row_num)
  FROM ranked_orders
  QUALIFY row_num = 1
)
SELECT
  l.order_id,
  l.customer_id,
  l.order_total,
  l.order_date,
  l.status,
  (
    SELECT SUM(p.amount)
    FROM `PROJECT_ID.DATASET.PAYMENTS` AS p
    WHERE p.order_id = l.order_id
  ) AS paid_amount
FROM latest_orders AS l;
