WITH l1 AS (
  SELECT order_id, customer_id, order_total
  FROM `PROJECT_ID.DATASET.ORDERS`
),
l2 AS (
  SELECT order_id, customer_id, order_total * 1.1 AS gross_total
  FROM l1
),
l3 AS (
  SELECT customer_id, SUM(gross_total) AS customer_total
  FROM l2
  GROUP BY customer_id
),
l4 AS (
  SELECT customer_id, customer_total, customer_total * 0.9 AS net_total
  FROM l3
),
l5 AS (
  SELECT customer_id, net_total
  FROM l4
)
SELECT customer_id, net_total
FROM l5
