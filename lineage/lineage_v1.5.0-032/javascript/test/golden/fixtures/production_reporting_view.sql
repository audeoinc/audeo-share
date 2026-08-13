WITH customer_orders AS (
  SELECT
    c.customer_id,
    c.name,
    c.region,
    o.order_id,
    o.order_total,
    o.order_date,
    ROW_NUMBER() OVER (
      PARTITION BY c.customer_id
      ORDER BY o.order_date DESC
    ) AS order_rank
  FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c
  LEFT JOIN `PROJECT_ID.DATASET.ORDERS` AS o
    ON c.customer_id = o.customer_id
),
latest_order AS (
  SELECT * EXCEPT(order_rank)
  FROM customer_orders
  QUALIFY order_rank = 1
)
SELECT
  customer_id,
  name,
  region,
  order_id AS latest_order_id,
  order_total AS latest_order_total,
  order_date AS latest_order_date
FROM latest_order;
