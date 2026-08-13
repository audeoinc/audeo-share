SELECT
  c.customer_id,
  EXISTS(
    SELECT 1 AS exists_marker
    FROM `PROJECT_ID.DATASET.ORDERS` AS o
    WHERE o.customer_id = c.customer_id
  ) AS has_order
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c;
