import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// Ensure extra columns on cutting_log
async function ensureCuttingColumns() {
  try {
    await pool.query(`
      ALTER TABLE cutting_log
        ADD COLUMN IF NOT EXISTS product_id UUID,
        ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS number_of_pieces INT DEFAULT 1,
        ADD COLUMN IF NOT EXISTS operator_notes TEXT
    `);
  } catch (_) {}
}
ensureCuttingColumns();

// GET /api/cutting
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, limit = '50', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let queryStr = `
      SELECT cl.*,
        p.name AS product_name,
        um.abbreviation AS unit,
        u.first_name || ' ' || u.last_name AS operator_name
      FROM cutting_log cl
      LEFT JOIN products p ON p.id = cl.product_id
      LEFT JOIN units_of_measure um ON um.id = p.unit_id
      LEFT JOIN users u ON u.id = cl.operator_id
      WHERE cl.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      queryStr += ` AND (COALESCE(p.name,'') ILIKE $${params.length} OR COALESCE(cl.customer_name,'') ILIKE $${params.length})`;
    }

    queryStr += ` ORDER BY cl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(queryStr, params);
    const today = new Date().toISOString().split('T')[0];

    const [todayCount, wasteResult, totalCount] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM cutting_log WHERE tenant_id = $1 AND DATE(created_at) = $2`, [tenantId, today]),
      pool.query(`SELECT AVG(CASE WHEN cut_quantity_requested > 0 THEN (waste_amount / cut_quantity_requested) * 100 ELSE 0 END) AS avg_waste FROM cutting_log WHERE tenant_id = $1 AND waste_amount IS NOT NULL`, [tenantId]),
      pool.query(`SELECT COUNT(*) FROM cutting_log WHERE tenant_id = $1`, [tenantId]),
    ]);

    res.json({
      success: true,
      logs: result.rows,
      total: parseInt(totalCount.rows[0].count),
      todayCount: parseInt(todayCount.rows[0].count),
      avgWaste: parseFloat(wasteResult.rows[0]?.avg_waste || '0'),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cutting
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    const { product_id, dimensional_stock_id, customer_name, cut_quantity_requested, number_of_pieces = 1, cutting_charge = 0, operator_notes } = req.body;

    if (!product_id || !cut_quantity_requested) {
      res.status(400).json({ success: false, message: 'Product ID and cut quantity are required' });
      return;
    }

    const totalCutQty = parseFloat(cut_quantity_requested) * parseInt(number_of_pieces);
    const wasteAmount = totalCutQty * 0.02;

    const logResult = await client.query(
      `INSERT INTO cutting_log (tenant_id, product_id, dimensional_stock_id, customer_name,
        cut_quantity_requested, actual_cut_length, waste_amount, number_of_pieces,
        cutting_charge, operator_id, operator_notes, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,'completed',NOW()) RETURNING *`,
      [tenantId, product_id, dimensional_stock_id || null, customer_name,
        totalCutQty, wasteAmount, number_of_pieces, cutting_charge, userId, operator_notes]
    );

    await client.query(
      `UPDATE inventory SET quantity_on_hand = GREATEST(0, quantity_on_hand - $1), updated_at = NOW()
       WHERE product_id = $2 AND tenant_id = $3`,
      [totalCutQty + wasteAmount, product_id, tenantId]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, log: logResult.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

export default router;
