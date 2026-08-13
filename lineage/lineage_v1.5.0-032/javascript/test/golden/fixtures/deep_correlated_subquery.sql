SELECT
  c.customer_id,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM `PROJECT_ID.DATASET.ORDERS` AS o
      WHERE o.customer_id = c.customer_id
        AND EXISTS (
          SELECT 1
          FROM `PROJECT_ID.DATASET.PAYMENTS` AS p
          WHERE p.order_id = o.order_id
            AND p.amount > c.customer_id
        )
    ) THEN c.name
    ELSE c.region
  END AS customer_label
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c
