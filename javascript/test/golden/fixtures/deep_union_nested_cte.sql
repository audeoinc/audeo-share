WITH base AS (
  SELECT customer_id, order_total AS amount
  FROM `PROJECT_ID.DATASET.ORDERS`
),
branches AS (
  SELECT customer_id, amount
  FROM base
  UNION ALL
  SELECT customer_id, amount * 0.9 AS amount
  FROM (
    SELECT customer_id, amount
    FROM base
  )
),
wrapped AS (
  SELECT customer_id, amount
  FROM (
    SELECT customer_id, amount
    FROM branches
  )
)
SELECT customer_id, SUM(amount) AS total_amount
FROM wrapped
GROUP BY customer_id
