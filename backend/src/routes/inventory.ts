import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { branch_id, low_stock } = req.query;
    let where = 'WHERE i.tenant_id = $1';
    const params: any[] = [tenantId];
    let idx = 2;
    if (branch_id) { where += ` AND i.branch_id = $${idx}`; params.push(branch_id); idx++; }
    if (low_stock === 'true') { where += ` AND i.quantity_on_hand <= p.reorder_level AND p.reorder_level > 0`; }
    const result = await query(`
      SELECT i.*, p.name as product_name, p.sku, p.barcode, p.reorder_level, p.product_type,
        c.name as category_name, u.abbreviation as unit, b.name as branch_name
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN units_of_measure u ON u.id = p.unit_id
      LEFT JOIN branches b ON b.id = i.branch_id
      ${where} ORDER BY p.name ASC
    `, params);
    return res.json({ success: true, inventory: result.rows });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/adjust', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { product_id, branch_id, adjustment_type, quantity_change, reason } = req.body;
    const invResult = await query('SELECT quantity_on_hand FROM inventory WHERE product_id=$1 AND branch_id=$2 AND tenant_id=$3', [product_id, branch_id, tenantId]);
    let qtyBefore = 0;
    if (invResult.rows.length) {
      qtyBefore = parseFloat(invResult.rows[0].quantity_on_hand);
      await query('UPDATE inventory SET quantity_on_hand = quantity_on_hand + $1, updated_at=NOW() WHERE product_id=$2 AND branch_id=$3 AND tenant_id=$4', [quantity_change, product_id, branch_id, tenantId]);
    } else {
      await query('INSERT INTO inventory (tenant_id, product_id, branch_id, quantity_on_hand) VALUES ($1,$2,$3,$4)', [tenantId, product_id, branch_id, Math.max(0, quantity_change)]);
    }
    await query(`INSERT INTO stock_adjustments (tenant_id, branch_id, product_id, adjustment_type, quantity_before, quantity_change, quantity_after, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, branch_id, product_id, adjustment_type, qtyBefore, quantity_change, qtyBefore + quantity_change, reason, req.user!.id]);
    return res.json({ success: true, message: 'Stock adjusted successfully' });
  } catch (error: any) { return res.status(500).json({ success: false, message: error.message }); }
});

export default router;
