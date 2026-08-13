-- ============================================================================
-- 02_setup_sample_environment.sql
-- BigQuery Physical Lineage Repository - Sample environment setup
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Bootstrap values
--
-- This sample script is self-contained so that the sample environment can be
-- created before or after repository setup.
-- Keep these values aligned with 01_setup_lineage_environment.sql.
-- ============================================================================
DECLARE sample_project_id STRING DEFAULT 'project_id';
DECLARE sample_dataset STRING DEFAULT 'dataset';
DECLARE sample_location STRING DEFAULT 'asia-northeast1';

DECLARE sample_dataset_full_name STRING DEFAULT FORMAT(
  '%s.%s',
  sample_project_id,
  sample_dataset
);

-- ============================================================================
-- 1. Sample Dataset
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE SCHEMA IF NOT EXISTS `%s`
  OPTIONS (
    location = '%s',
    description = 'Sample objects for BigQuery physical lineage validation'
  )
  ''',
  sample_dataset_full_name,
  sample_location
);

-- ============================================================================
-- 2. Physical tables
-- ============================================================================

-- Customer master with nested STRUCT and ARRAY<STRUCT>.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.customers`
  (
    customer_id STRING NOT NULL,
    customer_name STRING NOT NULL,
    customer_segment STRING,
    registered_date DATE,
    address STRUCT<
      postal_code STRING,
      prefecture STRING,
      city STRING
    >,
    contacts ARRAY<STRUCT<
      contact_type STRING,
      contact_value STRING,
      is_primary BOOL
    >>,
    updated_at TIMESTAMP NOT NULL
  )
  OPTIONS (
    description = 'Customer master sample with nested fields'
  )
  ''',
  sample_dataset_full_name
);

-- Product master.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.products`
  (
    product_id STRING NOT NULL,
    product_name STRING NOT NULL,
    category STRING,
    unit_price NUMERIC,
    attributes STRUCT<
      brand STRING,
      color STRING,
      size STRING
    >,
    updated_at TIMESTAMP NOT NULL
  )
  OPTIONS (
    description = 'Product master sample'
  )
  ''',
  sample_dataset_full_name
);

-- Sales header.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.sales_orders`
  (
    order_id STRING NOT NULL,
    customer_id STRING NOT NULL,
    order_date DATE NOT NULL,
    order_status STRING,
    sales_channel STRING,
    shipping_address STRUCT<
      postal_code STRING,
      prefecture STRING,
      city STRING
    >,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )
  OPTIONS (
    description = 'Sales order header sample'
  )
  ''',
  sample_dataset_full_name
);

-- Sales detail.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.sales_order_items`
  (
    order_id STRING NOT NULL,
    line_number INT64 NOT NULL,
    product_id STRING NOT NULL,
    quantity INT64 NOT NULL,
    unit_price NUMERIC NOT NULL,
    discount_amount NUMERIC,
    tax_amount NUMERIC,
    updated_at TIMESTAMP NOT NULL
  )
  OPTIONS (
    description = 'Sales order detail sample'
  )
  ''',
  sample_dataset_full_name
);

-- Scheduled Query / DAG destination table sample.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.daily_customer_sales`
  (
    sales_date DATE NOT NULL,
    customer_id STRING NOT NULL,
    order_count INT64,
    sales_amount NUMERIC,
    latest_order_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL
  )
  OPTIONS (
    description = 'Destination table for Scheduled Query validation'
  )
  ''',
  sample_dataset_full_name
);

-- ============================================================================
-- 3. Sample data
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  INSERT INTO `%s.customers`
  (
    customer_id,
    customer_name,
    customer_segment,
    registered_date,
    address,
    contacts,
    updated_at
  )
  VALUES
    (
      'C001',
      'Alice Trading',
      'ENTERPRISE',
      DATE '2024-01-10',
      STRUCT(
        '100-0001' AS postal_code,
        'tokyo' AS prefecture,
        'chiyoda' AS city
      ),
      [
        STRUCT(
          'EMAIL' AS contact_type,
          'alice@example.com' AS contact_value,
          TRUE AS is_primary
        ),
        STRUCT(
          'PHONE' AS contact_type,
          '03-0000-0001' AS contact_value,
          FALSE AS is_primary
        )
      ],
      TIMESTAMP '2026-07-01 00:00:00+00'
    ),
    (
      'C002',
      'Bob Retail',
      'SMB',
      DATE '2024-03-05',
      STRUCT(
        '150-0001' AS postal_code,
        'tokyo' AS prefecture,
        'shibuya' AS city
      ),
      [
        STRUCT(
          'EMAIL' AS contact_type,
          'bob@example.com' AS contact_value,
          TRUE AS is_primary
        )
      ],
      TIMESTAMP '2026-07-01 00:00:00+00'
    ),
    (
      'C003',
      'Carol Services',
      'MID_MARKET',
      DATE '2025-02-15',
      STRUCT(
        '220-0001' AS postal_code,
        'kanagawa' AS prefecture,
        'yokohama' AS city
      ),
      ARRAY<STRUCT<
        contact_type STRING,
        contact_value STRING,
        is_primary BOOL
      >>[],
      TIMESTAMP '2026-07-01 00:00:00+00'
    )
  ''',
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  INSERT INTO `%s.products`
  (
    product_id,
    product_name,
    category,
    unit_price,
    attributes,
    updated_at
  )
  VALUES
    (
      'P001',
      'Standard Plan',
      'SUBSCRIPTION',
      NUMERIC '10000',
      STRUCT(
        'BrandXX' AS brand,
        'BLUE' AS color,
        'M' AS size
      ),
      TIMESTAMP '2026-07-01 00:00:00+00'
    ),
    (
      'P002',
      'Premium Plan',
      'SUBSCRIPTION',
      NUMERIC '25000',
      STRUCT(
        'BrandXX' AS brand,
        'BLACK' AS color,
        'L' AS size
      ),
      TIMESTAMP '2026-07-01 00:00:00+00'
    ),
    (
      'P003',
      'Consulting Pack',
      'SERVICE',
      NUMERIC '80000',
      STRUCT(
        'BrandXX' AS brand,
        NULL AS color,
        NULL AS size
      ),
      TIMESTAMP '2026-07-01 00:00:00+00'
    )
  ''',
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  INSERT INTO `%s.sales_orders`
  (
    order_id,
    customer_id,
    order_date,
    order_status,
    sales_channel,
    shipping_address,
    created_at,
    updated_at
  )
  VALUES
    (
      'O1001',
      'C001',
      DATE '2026-06-01',
      'COMPLETED',
      'WEB',
      STRUCT(
        '100-0001' AS postal_code,
        'tokyo' AS prefecture,
        'chiyoda' AS city
      ),
      TIMESTAMP '2026-06-01 01:00:00+00',
      TIMESTAMP '2026-06-01 02:00:00+00'
    ),
    (
      'O1002',
      'C001',
      DATE '2026-06-15',
      'COMPLETED',
      'SALES',
      STRUCT(
        '100-0001' AS postal_code,
        'tokyo' AS prefecture,
        'chiyoda' AS city
      ),
      TIMESTAMP '2026-06-15 03:00:00+00',
      TIMESTAMP '2026-06-15 04:00:00+00'
    ),
    (
      'O1003',
      'C002',
      DATE '2026-07-01',
      'PROCESSING',
      'WEB',
      STRUCT(
        '150-0001' AS postal_code,
        'tokyo' AS prefecture,
        'shibuya' AS city
      ),
      TIMESTAMP '2026-07-01 05:00:00+00',
      TIMESTAMP '2026-07-01 06:00:00+00'
    )
  ''',
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  INSERT INTO `%s.sales_order_items`
  (
    order_id,
    line_number,
    product_id,
    quantity,
    unit_price,
    discount_amount,
    tax_amount,
    updated_at
  )
  VALUES
    (
      'O1001',
      1,
      'P001',
      2,
      NUMERIC '10000',
      NUMERIC '0',
      NUMERIC '2000',
      TIMESTAMP '2026-06-01 02:00:00+00'
    ),
    (
      'O1001',
      2,
      'P003',
      1,
      NUMERIC '80000',
      NUMERIC '5000',
      NUMERIC '7500',
      TIMESTAMP '2026-06-01 02:00:00+00'
    ),
    (
      'O1002',
      1,
      'P002',
      1,
      NUMERIC '25000',
      NUMERIC '2500',
      NUMERIC '2250',
      TIMESTAMP '2026-06-15 04:00:00+00'
    ),
    (
      'O1003',
      1,
      'P001',
      3,
      NUMERIC '10000',
      NUMERIC '0',
      NUMERIC '3000',
      TIMESTAMP '2026-07-01 06:00:00+00'
    )
  ''',
  sample_dataset_full_name
);

-- ============================================================================
-- 4. Sample Views
--
-- Dependency chain:
--
-- customers / products / sales_orders / sales_order_items
--       │
--       ├─ v_order_item_detail
--       │       │
--       │       └─ v_order_summary
--       │               │
--       │               └─ v_customer_sales
--       │                       │
--       │                       └─ v_customer_sales_ranked
--       │
--       ├─ v_customer_primary_contact
--       └─ v_customer_profile
--
-- The views intentionally exercise:
--   - JOIN
--   - CTE
--   - GROUP BY
--   - QUALIFY
--   - scalar subquery
--   - SELECT *
--   - SELECT * EXCEPT
--   - STRUCT field access
--   - UNNEST ARRAY<STRUCT>
--   - multiple dependency levels
-- ============================================================================

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_order_item_detail` AS
  SELECT
    orders.order_id,
    orders.order_date,
    orders.customer_id,
    orders.order_status,
    orders.sales_channel,
    orders.shipping_address.prefecture
      AS shipping_prefecture,
    items.line_number,
    items.product_id,
    products.product_name,
    products.category,
    products.attributes.brand AS product_brand,
    items.quantity,
    items.unit_price,
    COALESCE(items.discount_amount, 0)
      AS discount_amount,
    COALESCE(items.tax_amount, 0)
      AS tax_amount,
    (
      items.quantity * items.unit_price
      - COALESCE(items.discount_amount, 0)
      + COALESCE(items.tax_amount, 0)
    ) AS line_sales_amount
  FROM `%s.sales_orders` AS orders
  JOIN `%s.sales_order_items` AS items
    ON items.order_id = orders.order_id
  JOIN `%s.products` AS products
    ON products.product_id = items.product_id
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_order_summary` AS
  WITH order_lines AS (
    SELECT *
    FROM `%s.v_order_item_detail`
  )
  SELECT
    order_id,
    order_date,
    customer_id,
    order_status,
    sales_channel,
    shipping_prefecture,
    COUNT(*) AS line_count,
    SUM(quantity) AS total_quantity,
    SUM(line_sales_amount) AS order_sales_amount,
    ARRAY_AGG(
      STRUCT(
        product_id,
        product_name,
        line_sales_amount
      )
      ORDER BY line_number
    ) AS product_lines
  FROM order_lines
  GROUP BY
    order_id,
    order_date,
    customer_id,
    order_status,
    sales_channel,
    shipping_prefecture
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_customer_primary_contact` AS
  SELECT
    customer.customer_id,
    contact.contact_type,
    contact.contact_value
  FROM `%s.customers` AS customer
  LEFT JOIN UNNEST(customer.contacts) AS contact
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer.customer_id
    ORDER BY
      contact.is_primary DESC,
      contact.contact_type
  ) = 1
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name
);

-- Parser regression View: correlated LEFT JOIN UNNEST with explicit ON TRUE.
-- v_customer_primary_contact keeps the conditionless BigQuery syntax so both
-- supported forms are exercised by the repository integration pipeline.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_customer_primary_contact_on_true` AS
  SELECT
    customer.customer_id,
    contact.contact_type,
    contact.contact_value
  FROM `%s.customers` AS customer
  LEFT JOIN UNNEST(customer.contacts) AS contact
    ON TRUE
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer.customer_id
    ORDER BY
      contact.is_primary DESC,
      contact.contact_type
  ) = 1
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_customer_profile` AS
  SELECT
    customer.* EXCEPT(contacts),
    customer.address.prefecture AS customer_prefecture,
    customer.address.city AS customer_city,
    primary_contact.contact_type
      AS primary_contact_type,
    primary_contact.contact_value
      AS primary_contact_value
  FROM `%s.customers` AS customer
  LEFT JOIN `%s.v_customer_primary_contact`
    AS primary_contact
    ON primary_contact.customer_id = customer.customer_id
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_customer_sales` AS
  WITH customer_orders AS (
    SELECT
      customer_id,
      COUNT(*) AS order_count,
      SUM(order_sales_amount) AS sales_amount,
      MAX(order_date) AS latest_order_date
    FROM `%s.v_order_summary`
    GROUP BY customer_id
  )
  SELECT
    profile.customer_id,
    profile.customer_name,
    profile.customer_segment,
    profile.customer_prefecture,
    profile.customer_city,
    profile.primary_contact_type,
    profile.primary_contact_value,
    COALESCE(customer_orders.order_count, 0)
      AS order_count,
    COALESCE(customer_orders.sales_amount, 0)
      AS sales_amount,
    customer_orders.latest_order_date,
    (
      SELECT MAX(order_summary.order_sales_amount)
      FROM `%s.v_order_summary` AS order_summary
      WHERE order_summary.customer_id =
        profile.customer_id
    ) AS maximum_order_amount
  FROM `%s.v_customer_profile` AS profile
  LEFT JOIN customer_orders
    ON customer_orders.customer_id =
      profile.customer_id
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.v_customer_sales_ranked` AS
  SELECT
    customer_sales.*,
    DENSE_RANK() OVER (
      ORDER BY customer_sales.sales_amount DESC
    ) AS sales_rank
  FROM `%s.v_customer_sales` AS customer_sales
  QUALIFY sales_rank <= 100
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name
);

-- ============================================================================
-- 5. Scheduled Query validation SQL text
--
-- The repository collects Scheduled Query jobs from INFORMATION_SCHEMA.JOBS.
-- Register and run the statement below as a Scheduled Query when validation
-- of generated-table lineage becomes necessary.
-- ============================================================================
SELECT FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.daily_customer_sales` AS
  SELECT
    CURRENT_DATE('Asia/Tokyo') AS sales_date,
    customer_id,
    order_count,
    sales_amount,
    TIMESTAMP(latest_order_date) AS latest_order_at,
    CURRENT_TIMESTAMP() AS updated_at
  FROM `%s.v_customer_sales`
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name
) AS scheduled_query_sql;

-- ============================================================================
-- 6. Sample environment summary
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT
    @sample_dataset AS sample_dataset,
    (
      SELECT COUNT(*)
      FROM `%s.INFORMATION_SCHEMA.TABLES`
      WHERE table_type = 'BASE TABLE'
    ) AS physical_table_count,
    (
      SELECT COUNT(*)
      FROM `%s.INFORMATION_SCHEMA.VIEWS`
    ) AS view_count,
    (
      SELECT COUNT(*)
      FROM `%s.customers`
    ) AS customer_count,
    (
      SELECT COUNT(*)
      FROM `%s.sales_orders`
    ) AS order_count,
    (
      SELECT COUNT(*)
      FROM `%s.sales_order_items`
    ) AS order_item_count,
    CURRENT_TIMESTAMP() AS setup_finished_at
  ''',
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name,
  sample_dataset_full_name
)
USING sample_dataset_full_name AS sample_dataset;
