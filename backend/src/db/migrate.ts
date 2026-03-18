import { query } from '../config/database';
import logger from '../config/logger';

const createSchema = async () => {
  logger.info('🔄 Running database migrations...');

  await query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  `);

  // ─── TENANTS ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100) DEFAULT 'Kenya',
      logo_url TEXT,
      plan VARCHAR(50) DEFAULT 'basic',
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','suspended','trial')),
      trial_ends_at TIMESTAMPTZ,
      subscription_ends_at TIMESTAMPTZ,
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── USERS ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      password_hash TEXT NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      role VARCHAR(50) NOT NULL DEFAULT 'cashier' 
        CHECK (role IN ('superadmin','admin','manager','cashier','warehouse','accounts','cutting_operator','delivery')),
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
      avatar_url TEXT,
      last_login TIMESTAMPTZ,
      pin_hash TEXT,
      permissions JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, email)
    );
  `);

  // ─── BRANCHES ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS branches (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(20) NOT NULL,
      address TEXT,
      city VARCHAR(100),
      phone VARCHAR(50),
      email VARCHAR(255),
      is_main BOOLEAN DEFAULT false,
      status VARCHAR(20) DEFAULT 'active',
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, code)
    );
  `);

  // ─── CATEGORIES ─────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES categories(id),
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      description TEXT,
      icon VARCHAR(100),
      color VARCHAR(20),
      sort_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, slug)
    );
  `);

  // ─── UNITS OF MEASURE ───────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS units_of_measure (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      abbreviation VARCHAR(20) NOT NULL,
      type VARCHAR(50) CHECK (type IN ('count','length','weight','volume','area')),
      base_unit_id UUID REFERENCES units_of_measure(id),
      conversion_factor DECIMAL(20,8) DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── PRODUCTS ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      category_id UUID REFERENCES categories(id),
      unit_id UUID REFERENCES units_of_measure(id),
      name VARCHAR(255) NOT NULL,
      sku VARCHAR(100),
      barcode VARCHAR(100),
      description TEXT,
      product_type VARCHAR(50) DEFAULT 'standard' 
        CHECK (product_type IN ('standard','dimensional','serialized','batch','assembly','rental')),
      retail_price DECIMAL(15,2) NOT NULL DEFAULT 0,
      trade_price DECIMAL(15,2),
      wholesale_price DECIMAL(15,2),
      cost_price DECIMAL(15,2),
      tax_rate DECIMAL(5,2) DEFAULT 16.00,
      tax_exempt BOOLEAN DEFAULT false,
      weight_per_unit DECIMAL(10,3),
      length DECIMAL(10,3),
      width DECIMAL(10,3),
      height DECIMAL(10,3),
      thickness DECIMAL(10,3),
      gauge VARCHAR(50),
      track_serials BOOLEAN DEFAULT false,
      track_batches BOOLEAN DEFAULT false,
      allow_fractional BOOLEAN DEFAULT false,
      min_quantity DECIMAL(10,3) DEFAULT 1,
      reorder_level DECIMAL(10,3) DEFAULT 0,
      max_stock DECIMAL(10,3),
      image_url TEXT,
      images JSONB DEFAULT '[]',
      tags TEXT[],
      attributes JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT true,
      is_rentable BOOLEAN DEFAULT false,
      rental_daily_rate DECIMAL(15,2),
      rental_deposit DECIMAL(15,2),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, sku)
    );
  `);

  // ─── INVENTORY ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
      quantity_on_hand DECIMAL(15,3) DEFAULT 0,
      quantity_reserved DECIMAL(15,3) DEFAULT 0,
      quantity_available DECIMAL(15,3) GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED,
      location_zone VARCHAR(50),
      rack_number VARCHAR(50),
      bin_location VARCHAR(50),
      last_counted_at TIMESTAMPTZ,
      last_counted_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, product_id, branch_id)
    );
  `);

  // ─── DIMENSIONAL STOCK ──────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS dimensional_stock (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
      barcode VARCHAR(100) UNIQUE,
      original_length DECIMAL(10,3),
      original_weight DECIMAL(10,3),
      current_remaining DECIMAL(10,3) NOT NULL,
      status VARCHAR(20) DEFAULT 'full' CHECK (status IN ('full','partial','remnant','damaged','sold')),
      location_zone VARCHAR(50),
      rack_number VARCHAR(50),
      batch_id UUID,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── SERIAL NUMBERS ─────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS serial_numbers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id),
      serial_number VARCHAR(255) NOT NULL,
      status VARCHAR(30) DEFAULT 'in_stock' 
        CHECK (status IN ('in_stock','reserved','sold','returned','rented','damaged','lost')),
      warranty_months INT DEFAULT 12,
      date_received TIMESTAMPTZ DEFAULT NOW(),
      date_sold TIMESTAMPTZ,
      customer_id UUID,
      sale_id UUID,
      supplier_invoice_ref VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, serial_number)
    );
  `);

  // ─── BATCHES ────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS batches (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id) ON DELETE CASCADE,
      batch_number VARCHAR(100) NOT NULL,
      manufacture_date DATE,
      expiry_date DATE,
      quantity_received DECIMAL(15,3),
      quantity_remaining DECIMAL(15,3),
      supplier_id UUID,
      notes TEXT,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── CUSTOMERS ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      customer_number VARCHAR(50),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      phone2 VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      customer_type VARCHAR(30) DEFAULT 'retail' 
        CHECK (customer_type IN ('retail','contractor','corporate','property_manager','government')),
      company_name VARCHAR(255),
      trade_license_no VARCHAR(100),
      kra_pin VARCHAR(20),
      credit_limit DECIMAL(15,2) DEFAULT 0,
      current_balance DECIMAL(15,2) DEFAULT 0,
      discount_tier VARCHAR(20) DEFAULT 'none' CHECK (discount_tier IN ('none','bronze','silver','gold','platinum')),
      discount_percentage DECIMAL(5,2) DEFAULT 0,
      is_credit_approved BOOLEAN DEFAULT false,
      notes TEXT,
      loyalty_points INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, customer_number)
    );
  `);

  // ─── SUPPLIERS ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      supplier_number VARCHAR(50),
      name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      kra_pin VARCHAR(20),
      supplier_type VARCHAR(50) CHECK (supplier_type IN ('manufacturer','distributor','importer','local_artisan','wholesaler')),
      payment_terms INT DEFAULT 30,
      credit_limit DECIMAL(15,2),
      current_balance DECIMAL(15,2) DEFAULT 0,
      bank_details JSONB DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── PURCHASE ORDERS ────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id),
      supplier_id UUID REFERENCES suppliers(id),
      po_number VARCHAR(50) NOT NULL,
      status VARCHAR(30) DEFAULT 'draft' 
        CHECK (status IN ('draft','sent','partial','received','cancelled')),
      order_date DATE DEFAULT CURRENT_DATE,
      expected_delivery DATE,
      actual_delivery DATE,
      subtotal DECIMAL(15,2) DEFAULT 0,
      tax_amount DECIMAL(15,2) DEFAULT 0,
      total_amount DECIMAL(15,2) DEFAULT 0,
      amount_paid DECIMAL(15,2) DEFAULT 0,
      payment_terms INT DEFAULT 30,
      notes TEXT,
      customer_id UUID REFERENCES customers(id),
      is_special_order BOOLEAN DEFAULT false,
      created_by UUID REFERENCES users(id),
      approved_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, po_number)
    );
  `);

  // ─── PURCHASE ORDER ITEMS ───────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      po_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id),
      quantity_ordered DECIMAL(15,3) NOT NULL,
      quantity_received DECIMAL(15,3) DEFAULT 0,
      unit_cost DECIMAL(15,2) NOT NULL,
      total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity_ordered * unit_cost) STORED,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── SALES ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id),
      sale_number VARCHAR(50) NOT NULL,
      customer_id UUID REFERENCES customers(id),
      customer_name VARCHAR(255),
      cashier_id UUID REFERENCES users(id),
      sale_date TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(30) DEFAULT 'completed' 
        CHECK (status IN ('draft','completed','refunded','partial_refund','void')),
      sale_type VARCHAR(30) DEFAULT 'retail' 
        CHECK (sale_type IN ('retail','trade','wholesale','special_order','rental')),
      subtotal DECIMAL(15,2) DEFAULT 0,
      discount_amount DECIMAL(15,2) DEFAULT 0,
      tax_amount DECIMAL(15,2) DEFAULT 0,
      total_amount DECIMAL(15,2) DEFAULT 0,
      amount_paid DECIMAL(15,2) DEFAULT 0,
      change_given DECIMAL(15,2) DEFAULT 0,
      balance_due DECIMAL(15,2) DEFAULT 0,
      payment_status VARCHAR(30) DEFAULT 'paid' 
        CHECK (payment_status IN ('paid','partial','credit','pending')),
      notes TEXT,
      lpo_number VARCHAR(100),
      project_code VARCHAR(100),
      delivery_required BOOLEAN DEFAULT false,
      delivery_address TEXT,
      delivery_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, sale_number)
    );
  `);

  // ─── SALE ITEMS ─────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
      product_id UUID REFERENCES products(id),
      product_name VARCHAR(255) NOT NULL,
      quantity DECIMAL(15,3) NOT NULL,
      unit_of_measure VARCHAR(50),
      unit_price DECIMAL(15,2) NOT NULL,
      discount_percent DECIMAL(5,2) DEFAULT 0,
      discount_amount DECIMAL(15,2) DEFAULT 0,
      tax_rate DECIMAL(5,2) DEFAULT 16,
      tax_amount DECIMAL(15,2) DEFAULT 0,
      total_price DECIMAL(15,2) NOT NULL,
      serial_number_id UUID REFERENCES serial_numbers(id),
      batch_id UUID REFERENCES batches(id),
      dimensional_stock_id UUID REFERENCES dimensional_stock(id),
      is_cut_to_size BOOLEAN DEFAULT false,
      cut_instructions TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── PAYMENTS ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      sale_id UUID REFERENCES sales(id),
      customer_id UUID REFERENCES customers(id),
      payment_method VARCHAR(50) NOT NULL 
        CHECK (payment_method IN ('cash','mpesa','card','bank_transfer','credit','lpo','cheque','split')),
      amount DECIMAL(15,2) NOT NULL,
      reference_number VARCHAR(100),
      mpesa_transaction_id VARCHAR(100),
      mpesa_phone VARCHAR(20),
      status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','reversed')),
      payment_date TIMESTAMPTZ DEFAULT NOW(),
      processed_by UUID REFERENCES users(id),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── CUTTING LOG ────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS cutting_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      sale_item_id UUID REFERENCES sale_items(id),
      dimensional_stock_id UUID REFERENCES dimensional_stock(id),
      cut_quantity_requested DECIMAL(10,3),
      actual_cut_length DECIMAL(10,3),
      waste_amount DECIMAL(10,3),
      cutting_charge DECIMAL(15,2) DEFAULT 0,
      operator_id UUID REFERENCES users(id),
      cut_instructions TEXT,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── TOOL RENTALS ───────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS tool_rentals (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      rental_number VARCHAR(50) NOT NULL,
      customer_id UUID REFERENCES customers(id),
      serial_number_id UUID REFERENCES serial_numbers(id),
      product_id UUID REFERENCES products(id),
      daily_rate DECIMAL(15,2) NOT NULL,
      deposit_amount DECIMAL(15,2) NOT NULL,
      date_out TIMESTAMPTZ DEFAULT NOW(),
      expected_return TIMESTAMPTZ,
      actual_return TIMESTAMPTZ,
      condition_out TEXT,
      condition_in TEXT,
      total_days INT,
      total_amount DECIMAL(15,2),
      late_fees DECIMAL(15,2) DEFAULT 0,
      deposit_returned BOOLEAN DEFAULT false,
      status VARCHAR(30) DEFAULT 'out' CHECK (status IN ('out','returned','overdue','damaged')),
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── STOCK ADJUSTMENTS ──────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id),
      product_id UUID REFERENCES products(id),
      adjustment_type VARCHAR(50) CHECK (adjustment_type IN 
        ('add','remove','damage','theft','sample','internal_use','cutting_waste','correction','return')),
      quantity_before DECIMAL(15,3),
      quantity_change DECIMAL(15,3) NOT NULL,
      quantity_after DECIMAL(15,3),
      reason TEXT,
      reference_number VARCHAR(100),
      approved_by UUID REFERENCES users(id),
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── EXPENSES ───────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      branch_id UUID REFERENCES branches(id),
      category VARCHAR(100),
      description TEXT NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      payment_method VARCHAR(50),
      receipt_url TEXT,
      approved_by UUID REFERENCES users(id),
      created_by UUID REFERENCES users(id),
      status VARCHAR(20) DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── AUDIT LOG ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id),
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(100),
      resource_id UUID,
      old_values JSONB,
      new_values JSONB,
      ip_address VARCHAR(50),
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── NOTIFICATIONS ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id),
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) CHECK (type IN ('info','warning','error','success','alert')),
      is_read BOOLEAN DEFAULT false,
      action_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ─── INDEXES ────────────────────────────────────────────────
  await query(`
    CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(tenant_id, sku);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(tenant_id, barcode);
    CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(tenant_id, product_id, branch_id);
    CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON sales(tenant_id, sale_date);
    CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(tenant_id, phone);
    CREATE INDEX IF NOT EXISTS idx_serial_numbers_sn ON serial_numbers(tenant_id, serial_number);
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_user ON audit_logs(tenant_id, user_id, created_at);
  `);

  logger.info('✅ Database migration completed successfully!');
};

createSchema().catch((err) => {
  logger.error('Migration failed:', err);
  process.exit(1);
});
