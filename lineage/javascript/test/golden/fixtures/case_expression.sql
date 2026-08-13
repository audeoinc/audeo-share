SELECT
  customer_id,
  CASE
    WHEN unit_price * quantity >= 100000 THEN 'HIGH'
    WHEN discount_rate > 0 THEN 'DISCOUNTED'
    ELSE 'NORMAL'
  END AS purchase_class
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
