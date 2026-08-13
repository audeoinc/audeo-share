SELECT
  c.region,
  SUM(h.unit_price * h.quantity) AS region_sales
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY` h
JOIN `PROJECT_ID.DATASET.CUSTOMER_MASTER` c
  ON h.customer_id = c.customer_id
GROUP BY c.region
