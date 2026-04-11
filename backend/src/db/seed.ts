import { query } from '../config/database';
import bcrypt from 'bcryptjs';
import logger from '../config/logger';

const seed = async () => {
  logger.info('🌱 Seeding database...');

  // Create or update superadmin user (no tenant)
  const passwordHash = await bcrypt.hash('Mycat@95', 12);

  const existingSuperadmin = await query(`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`);
  if (existingSuperadmin.rows.length) {
    // Update existing superadmin credentials
    await query(
      `UPDATE users SET email = $1, password_hash = $2, updated_at = NOW() WHERE id = $3`,
      ['helvinotechltd@gmail.com', passwordHash, existingSuperadmin.rows[0].id]
    );
  } else {
    // Insert new superadmin
    await query(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, status)
       VALUES (NULL, $1, $2, 'Super', 'Admin', 'superadmin', 'active')`,
      ['helvinotechltd@gmail.com', passwordHash]
    );
  }

  // Demo tenant
  const tenantResult = await query(`
    INSERT INTO tenants (name, slug, email, phone, address, city, plan, status)
    VALUES (
      'Demo Hardware Store',
      'demo-hardware',
      'demo@hardwarestore.co.ke',
      '0712345678',
      'Moi Avenue, Shop 12',
      'Nairobi',
      'professional',
      'active'
    ) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);

  const tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) return;

  // Demo admin
  const adminHash = await bcrypt.hash('Admin@2024!', 12);
  await query(`
    INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, status)
    VALUES ($1, 'admin@demo.co.ke', $2, 'Demo', 'Admin', 'admin', 'active')
    ON CONFLICT (tenant_id, email) DO NOTHING
  `, [tenantId, adminHash]);

  // Demo branch
  const branchResult = await query(`
    INSERT INTO branches (tenant_id, name, code, address, city, is_main, status)
    VALUES ($1, 'Main Branch', 'MAIN', 'Moi Avenue, Shop 12', 'Nairobi', true, 'active')
    ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [tenantId]);

  const branchId = branchResult.rows[0]?.id;

  // Units of measure
  const units = [
    { name: 'Piece', abbreviation: 'pcs', type: 'count' },
    { name: 'Meter', abbreviation: 'm', type: 'length' },
    { name: 'Kilogram', abbreviation: 'kg', type: 'weight' },
    { name: 'Liter', abbreviation: 'L', type: 'volume' },
    { name: 'Square Meter', abbreviation: 'sqm', type: 'area' },
    { name: 'Box', abbreviation: 'box', type: 'count' },
    { name: 'Roll', abbreviation: 'roll', type: 'count' },
    { name: 'Bag', abbreviation: 'bag', type: 'weight' },
    { name: 'Bundle', abbreviation: 'bdl', type: 'count' },
  ];

  for (const unit of units) {
    await query(`
      INSERT INTO units_of_measure (tenant_id, name, abbreviation, type)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [tenantId, unit.name, unit.abbreviation, unit.type]);
  }

  // Categories
  const categories = [
    { name: 'Building Materials', slug: 'building-materials', icon: 'building', color: '#ef4444' },
    { name: 'Plumbing', slug: 'plumbing', icon: 'droplets', color: '#3b82f6' },
    { name: 'Electrical', slug: 'electrical', icon: 'zap', color: '#f59e0b' },
    { name: 'Tools', slug: 'tools', icon: 'wrench', color: '#8b5cf6' },
    { name: 'Hardware & Fasteners', slug: 'hardware', icon: 'settings', color: '#6b7280' },
    { name: 'Paint & Coatings', slug: 'paint', icon: 'paintbrush', color: '#ec4899' },
    { name: 'Agricultural', slug: 'agricultural', icon: 'leaf', color: '#22c55e' },
    { name: 'Kitchen & Bathroom', slug: 'kitchen-bathroom', icon: 'home', color: '#14b8a6' },
  ];

  for (const cat of categories) {
    await query(`
      INSERT INTO categories (tenant_id, name, slug, icon, color)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (tenant_id, slug) DO NOTHING
    `, [tenantId, cat.name, cat.slug, cat.icon, cat.color]);
  }

  logger.info('✅ Seed completed!');
  logger.info('🔑 SuperAdmin: helvinotechltd@gmail.com / Mycat@95');
  logger.info('🔑 Demo Admin: admin@demo.co.ke / Admin@2024!');
};

seed().catch((err) => {
  logger.error('Seed failed:', err);
  process.exit(1);
});
