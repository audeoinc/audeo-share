SELECT
  c.* EXCEPT(address),
  o.order_total
FROM `PROJECT_ID.DATASET.CUSTOMERS` AS c
JOIN `PROJECT_ID.DATASET.ORDERS` AS o
  ON c.customer_id = o.customer_id
