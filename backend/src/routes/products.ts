import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { page = 1, limit = 50, search = '', category = '', type = '', active = 'true' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE p.tenant_id = $1';
    const params: any[] = [tenantId];
    let i = 2;
    if (search) { where += ` AND (p.name ILIKE $${i} OR p.sku ILIKE $${i} OR p.barcode ILIKE $${i})`; params.push(`%${search}%`); i++; }
    if (category) { where += ` AND p.category_id = $${i}`; params.push(category); i++; }
    if (type) { where += ` AND p.product_type = $${i}`; params.push(type); i++; }
    if (active !== 'all') { where += ` AND p.is_active = $${i}`; params.push(active === 'true'); i++; }
    const countRes = await query(`SELECT COUNT(*) FROM products p ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    const result = await query(`
      SELECT p.*, c.name as category_name, c.color as category_color,
        u.name as unit_name, u.abbreviation as unit_abbreviation,
        COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id), 0) as total_stock
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN units_of_measure u ON u.id = p.unit_id
      ${where} ORDER BY p.name ASC LIMIT $${i} OFFSET $${i+1}
    `, [...params, Number(limit), offset]);
    return res.json({ success: true, products: result.rows, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
  } catch (error) { console.error(error); return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT p.*, c.name as category_name, u.name as unit_name, u.abbreviation as unit_abbreviation,
        COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.id), 0) as total_stock
      FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN units_of_measure u ON u.id = p.unit_id
      WHERE p.id = $1 AND p.tenant_id = $2
    `, [req.params.id, req.user!.tenantId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.json({ success: true, product: result.rows[0] });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      name, sku, barcode, description, category_id, unit_id, product_type,
      retail_price, trade_price, wholesale_price, cost_price,
      tax_rate, tax_exempt, weight_per_unit, length, width, height, thickness, gauge,
      track_serials, track_batches, allow_fractional, min_quantity, reorder_level, max_stock,
      image_url, tags, attributes, is_rentable, rental_daily_rate, rental_deposit,
      // Opening stock fields
      opening_stock, opening_stock_branch_id, opening_stock_notes,
    } = req.body;

    const result = await query(`
      INSERT INTO products (tenant_id, name, sku, barcode, description, category_id, unit_id, product_type, retail_price, trade_price, wholesale_price, cost_price, tax_rate, tax_exempt, weight_per_unit, length, width, height, thickness, gauge, track_serials, track_batches, allow_fractional, min_quantity, reorder_level, max_stock, image_url, tags, attributes, is_rentable, rental_daily_rate, rental_deposit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING *
    `, [tenantId, name, sku, barcode, description, category_id, unit_id, product_type || 'standard', retail_price, trade_price, wholesale_price, cost_price, tax_rate || 16, tax_exempt || false, weight_per_unit, length, width, height, thickness, gauge, track_serials || false, track_batches || false, allow_fractional || false, min_quantity || 1, reorder_level || 0, max_stock, image_url, tags || [], JSON.stringify(attributes || {}), is_rentable || false, rental_daily_rate, rental_deposit]);

    const product = result.rows[0];

    // Always create an inventory record so the product appears in inventory management
    const qty = opening_stock ? parseFloat(opening_stock) : 0;
    // Resolve branch: use provided, else main branch
    let branchId = opening_stock_branch_id || null;
    if (!branchId) {
      const mainBranch = await query(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_main = true LIMIT 1',
        [tenantId]
      );
      branchId = mainBranch.rows[0]?.id || null;
    }
    if (branchId) {
      await query(
        `INSERT INTO inventory (tenant_id, product_id, branch_id, quantity_on_hand)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, product_id, branch_id)
         DO UPDATE SET quantity_on_hand = inventory.quantity_on_hand + $4, updated_at = NOW()`,
        [tenantId, product.id, branchId, qty]
      );
      if (qty > 0) {
        await query(
          `INSERT INTO stock_adjustments (tenant_id, branch_id, product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, created_by)
           VALUES ($1,$2,$3,'add',0,$4,$4,$5,$6)`,
          [tenantId, branchId, product.id, qty, opening_stock_notes || 'Opening stock', req.user!.id]
        );
      }
    }

    return res.status(201).json({ success: true, product: { ...product, total_stock: qty } });
  } catch (error: any) {
    console.error('Product create error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;

    // Whitelist actual product columns — reject computed/joined fields like category_name, total_stock, etc.
    const ALLOWED_COLUMNS = new Set([
      'name', 'sku', 'barcode', 'description', 'category_id', 'unit_id', 'product_type',
      'retail_price', 'trade_price', 'wholesale_price', 'cost_price',
      'tax_rate', 'tax_exempt', 'weight_per_unit', 'length', 'width', 'height',
      'thickness', 'gauge', 'track_serials', 'track_batches', 'allow_fractional',
      'min_quantity', 'reorder_level', 'max_stock', 'image_url', 'tags', 'attributes',
      'is_active', 'is_rentable', 'rental_daily_rate', 'rental_deposit',
    ]);

    const fields = req.body;
    const keys = Object.keys(fields).filter(k => ALLOWED_COLUMNS.has(k));
    if (!keys.length) return res.status(400).json({ success: false, message: 'No valid fields to update' });

    const values = keys.map(k => fields[k]);
    const setClauses = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const result = await query(
      `UPDATE products SET ${setClauses}, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, ...values]
    );
    return res.json({ success: true, product: result.rows[0] });
  } catch (error: any) {
    console.error('Product update error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    await query('UPDATE products SET is_active = false WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user!.tenantId]);
    return res.json({ success: true, message: 'Product deactivated' });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

export default router;
