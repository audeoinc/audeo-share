SELECT * EXCEPT(discount_rate),
       unit_price * quantity AS gross_amount
FROM `PROJECT_ID.DATASET.CUSTOMER_PURCHASE_HISTORY`
