import { Router, Response } from 'express';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// Ensure extra columns on purchase_orders
async function ensurePOColumns() {
  try {
    await pool.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN IF NOT EXISTS total_value DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)
    `);
    await pool.query(`
      ALTER TABLE purchase_order_items
        ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS product_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS total_cost_calc DECIMAL(15,2) DEFAULT 0
    `);
  } catch {}
}
ensurePOColumns();

// GET /api/purchases
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, status, limit = '50', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let query = `
      SELECT po.*,
        s.name AS supplier_name,
        (SELECT COUNT(*) FROM purchase_order_items poi WHERE COALESCE(poi.purchase_order_id, poi.po_id) = po.id) AS item_count
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (po.po_number ILIKE $${params.length} OR s.name ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      query += ` AND po.status = $${params.length}`;
    }

    query += ` ORDER BY po.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countRes = await pool.query('SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = $1', [tenantId]);

    res.json({ success: true, purchase_orders: result.rows, total: parseInt(countRes.rows[0].count) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/purchases/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const po = await pool.query(
      `SELECT po.*, s.name AS supplier_name, s.contact_person, s.phone AS supplier_phone
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = $1 AND po.tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (!po.rows.length) { res.status(404).json({ success: false, message: 'PO not found' }); return; }

    const items = await pool.query(
      `SELECT poi.* FROM purchase_order_items poi
       WHERE COALESCE(poi.purchase_order_id, poi.po_id) = $1`,
      [req.params.id]
    );
    res.json({ success: true, purchase_order: { ...po.rows[0], items: items.rows } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/purchases
router.post('/', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    const { supplier_id, expected_delivery, payment_terms = 30, notes, is_special_order = false, customer_name, items = [] } = req.body;
    // Accept both string ('net_30') and numeric (30) payment_terms
    const termMap: Record<string, number> = { cash_on_delivery: 0, net_7: 7, net_14: 14, net_30: 30, net_60: 60, net_90: 90 };
    const termDays = typeof payment_terms === 'number' ? payment_terms
      : (termMap[String(payment_terms)] !== undefined ? termMap[String(payment_terms)] : (parseInt(String(payment_terms)) || 30));

    if (!supplier_id) { res.status(400).json({ success: false, message: 'Supplier is required' }); return; }
    if (!items.length) { res.status(400).json({ success: false, message: 'Add at least one item' }); return; }

    const countRes = await client.query('SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = $1', [tenantId]);
    const poNumber = `PO-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(5, '0')}`;
    const totalValue = items.reduce((s: number, i: any) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_cost) || 0), 0);

    const po = await client.query(
      `INSERT INTO purchase_orders (tenant_id, supplier_id, po_number, status, expected_delivery,
        total_amount, total_value, payment_terms, notes, is_special_order, customer_name, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tenantId, supplier_id, poNumber, expected_delivery || null, totalValue, termDays, notes, is_special_order, customer_name || null, userId]
    );

    for (const item of items) {
      const itemTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_cost) || 0);
      await client.query(
        `INSERT INTO purchase_order_items (po_id, purchase_order_id, product_id, product_name, quantity_ordered, unit_cost, total_cost_calc, notes)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7)`,
        [po.rows[0].id, item.product_id || null, item.product_name, parseFloat(item.quantity), parseFloat(item.unit_cost) || 0, itemTotal, item.notes]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, purchase_order: po.rows[0], message: `PO ${poNumber} created` });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/purchases/:id/status
router.patch('/:id/status', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const { status } = req.body;
    const validStatuses = ['draft', 'sent', 'partial', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) { res.status(400).json({ success: false, message: 'Invalid status' }); return; }

    const extra = status === 'received' ? ', actual_delivery = NOW()' : '';
    const result = await pool.query(
      `UPDATE purchase_orders SET status=$1${extra}, updated_at=NOW() WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [status, req.params.id, tenantId]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'PO not found' }); return; }
    res.json({ success: true, purchase_order: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
