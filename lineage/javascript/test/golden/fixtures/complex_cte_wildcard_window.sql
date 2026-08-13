WITH normalized_orders AS (
  SELECT * EXCEPT(updated_at) REPLACE(order_total * 1.1 AS order_total)
  FROM `PROJECT_ID.DATASET.ORDERS`
),
joined AS (
  SELECT
    o.*,
    UPPER(c.name) AS customer_name,
    c.region
  FROM normalized_orders AS o
  JOIN `PROJECT_ID.DATASET.CUSTOMERS` AS c
    ON o.customer_id = c.customer_id
)
SELECT
  customer_id,
  customer_name,
  region,
  order_total,
  ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS order_rank
FROM joined
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1
