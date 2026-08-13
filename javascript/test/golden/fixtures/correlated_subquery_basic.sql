SELECT
  c.customer_id,
  (
    SELECT MAX(o.order_total) AS internal_max_order_total
    FROM `PROJECT_ID.DATASET.ORDERS` AS o
    WHERE o.customer_id = c.customer_id
  ) AS max_order_total
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c;
