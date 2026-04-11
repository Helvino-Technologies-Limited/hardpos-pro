import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

// GET all products with their current stock levels (LEFT JOIN so products with no stock appear)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { branch_id, low_stock, search } = req.query;

    // Auto-backfill: ensure every active product has at least one inventory row
    // (uses the tenant's main branch; ON CONFLICT DO NOTHING makes this idempotent)
    await query(`
      INSERT INTO inventory (tenant_id, product_id, branch_id, quantity_on_hand)
      SELECT p.tenant_id, p.id, b.id, 0
      FROM products p
      CROSS JOIN (
        SELECT id FROM branches WHERE tenant_id = $1 AND is_main = true LIMIT 1
      ) b
      WHERE p.tenant_id = $1
        AND p.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM inventory i
          WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
        )
      ON CONFLICT (tenant_id, product_id, branch_id) DO NOTHING
    `, [tenantId]);

    let where = 'WHERE p.tenant_id = $1 AND p.is_active = true';
    const params: any[] = [tenantId];
    let idx = 2;

    if (search) {
      where += ` AND (p.name ILIKE $${idx} OR p.sku ILIKE $${idx} OR p.barcode ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    // Branch filter applies to inventory join
    let invJoin = `LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id`;
    if (branch_id) {
      invJoin = `LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id AND i.branch_id = $${idx}`;
      params.push(branch_id);
      idx++;
    }

    let havingClause = '';
    if (low_stock === 'true') {
      havingClause = 'HAVING COALESCE(SUM(i.quantity_on_hand), 0) <= p.reorder_level AND p.reorder_level > 0';
    }

    const result = await query(`
      SELECT
        p.id                                                          AS product_id,
        p.name                                                        AS product_name,
        p.sku,
        p.barcode,
        p.reorder_level,
        p.product_type,
        p.cost_price,
        p.retail_price,
        c.name                                                        AS category_name,
        u.abbreviation                                                AS unit,
        COALESCE(SUM(i.quantity_on_hand),   0)                       AS quantity_on_hand,
        COALESCE(SUM(i.quantity_reserved),  0)                       AS quantity_reserved,
        COALESCE(SUM(i.quantity_on_hand) - SUM(i.quantity_reserved), 0) AS quantity_available,
        -- pick any existing branch_id for this product (used by adjust modal as default)
        MIN(i.branch_id::text)::uuid                                 AS branch_id,
        MIN(b.name)                                                  AS branch_name,
        MIN(i.location_zone)                                         AS location_zone,
        MIN(i.rack_number)                                           AS rack_number,
        MIN(i.bin_location)                                          AS bin_location
      FROM products p
      ${invJoin}
      LEFT JOIN categories   c ON c.id = p.category_id
      LEFT JOIN units_of_measure u ON u.id = p.unit_id
      LEFT JOIN branches     b ON b.id = i.branch_id
      ${where}
      GROUP BY p.id, p.name, p.sku, p.barcode, p.reorder_level, p.product_type,
               p.cost_price, p.retail_price, c.name, u.abbreviation
      ${havingClause}
      ORDER BY p.name ASC
    `, params);

    return res.json({ success: true, inventory: result.rows });
  } catch (error) {
    console.error('Inventory GET error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /adjust — adjust stock for a product; auto-uses main branch if no branch_id given
router.post('/adjust', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { product_id, branch_id, adjustment_type, quantity_change, reason } = req.body;

    if (!product_id) {
      return res.status(400).json({ success: false, message: 'product_id is required' });
    }
    if (quantity_change === undefined || quantity_change === null || quantity_change === '') {
      return res.status(400).json({ success: false, message: 'quantity_change is required' });
    }

    // Resolve branch — use provided, else fall back to the product's existing branch, else main branch
    let resolvedBranchId = branch_id || null;
    if (!resolvedBranchId) {
      const existingInv = await query(
        'SELECT branch_id FROM inventory WHERE product_id = $1 AND tenant_id = $2 ORDER BY created_at LIMIT 1',
        [product_id, tenantId]
      );
      resolvedBranchId = existingInv.rows[0]?.branch_id || null;
    }
    if (!resolvedBranchId) {
      const mainBranch = await query(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_main = true LIMIT 1',
        [tenantId]
      );
      resolvedBranchId = mainBranch.rows[0]?.id || null;
    }
    if (!resolvedBranchId) {
      return res.status(400).json({ success: false, message: 'No branch found for this tenant' });
    }

    const invResult = await query(
      'SELECT quantity_on_hand FROM inventory WHERE product_id = $1 AND branch_id = $2 AND tenant_id = $3',
      [product_id, resolvedBranchId, tenantId]
    );

    const qtyBefore = invResult.rows.length ? parseFloat(invResult.rows[0].quantity_on_hand) : 0;
    const qtyChange = parseFloat(quantity_change);
    const qtyAfter = qtyBefore + qtyChange;

    if (invResult.rows.length) {
      await query(
        'UPDATE inventory SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW() WHERE product_id = $2 AND branch_id = $3 AND tenant_id = $4',
        [qtyChange, product_id, resolvedBranchId, tenantId]
      );
    } else {
      await query(
        'INSERT INTO inventory (tenant_id, product_id, branch_id, quantity_on_hand) VALUES ($1,$2,$3,$4)',
        [tenantId, product_id, resolvedBranchId, Math.max(0, qtyChange)]
      );
    }

    await query(
      `INSERT INTO stock_adjustments (tenant_id, branch_id, product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, resolvedBranchId, product_id, adjustment_type, qtyBefore, qtyChange, qtyAfter, reason || null, req.user!.id]
    );

    return res.json({ success: true, message: 'Stock adjusted successfully', quantity_after: qtyAfter });
  } catch (error: any) {
    console.error('Adjust error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
