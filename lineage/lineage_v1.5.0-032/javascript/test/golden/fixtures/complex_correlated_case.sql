SELECT
  c.customer_id,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM `PROJECT_ID.DATASET.ORDERS` AS o
      WHERE o.customer_id = c.customer_id
        AND o.order_total > 100
    ) THEN UPPER(c.name)
    ELSE c.region
  END AS customer_label
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c
