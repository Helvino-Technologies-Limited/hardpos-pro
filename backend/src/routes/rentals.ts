import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// Ensure extra columns
async function ensureRentalColumns() {
  try {
    await pool.query(`
      ALTER TABLE tool_rentals
        ADD COLUMN IF NOT EXISTS weekly_rate DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS expected_return_date TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS actual_return_date TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS late_fees_charged DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_charged DECIMAL(15,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS notes TEXT
    `);
  } catch (_) {}
}
ensureRentalColumns();

// GET /api/rentals
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, status, limit = '50', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let queryStr = `
      SELECT tr.*,
        p.name AS product_name,
        sn.serial_number,
        c.name AS customer_name, c.phone AS customer_phone
      FROM tool_rentals tr
      LEFT JOIN products p ON p.id = tr.product_id
      LEFT JOIN serial_numbers sn ON sn.id = tr.serial_number_id
      LEFT JOIN customers c ON c.id = tr.customer_id
      WHERE tr.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      queryStr += ` AND (COALESCE(c.name,'') ILIKE $${params.length} OR COALESCE(p.name,'') ILIKE $${params.length})`;
    }

    if (status === 'overdue') {
      queryStr += ` AND tr.status = 'out' AND COALESCE(tr.expected_return_date, tr.expected_return) < NOW()`;
    } else if (status === 'active') {
      queryStr += ` AND tr.status = 'out'`;
    } else if (status === 'returned') {
      queryStr += ` AND tr.status = 'returned'`;
    }

    queryStr += ` ORDER BY tr.date_out DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(queryStr, params);

    const rentals = result.rows.map(r => {
      const expReturn = r.expected_return_date || r.expected_return;
      const isOverdue = r.status === 'out' && expReturn && new Date(expReturn) < new Date();
      return {
        ...r,
        status: isOverdue ? 'overdue' : r.status === 'out' ? 'active' : r.status,
        expected_return_date: expReturn,
        date_out: r.date_out,
      };
    });

    res.json({ success: true, rentals, total: rentals.length });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/rentals
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    const { product_id, customer_id, serial_number_id, daily_rate, weekly_rate, deposit_amount, expected_return_date, notes, condition_out = 'good' } = req.body;

    const parsedDailyRate  = parseFloat(String(daily_rate));
    const parsedDeposit    = parseFloat(String(deposit_amount ?? 0));
    if (!product_id || !customer_id || isNaN(parsedDailyRate) || parsedDailyRate <= 0) {
      res.status(400).json({ success: false, message: 'Product, customer and daily rate are required' });
      return;
    }

    const countRes = await client.query('SELECT COUNT(*) FROM tool_rentals WHERE tenant_id = $1', [tenantId]);
    const rentalNumber = `RNT-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;

    const result = await client.query(
      `INSERT INTO tool_rentals (tenant_id, rental_number, product_id, customer_id, serial_number_id,
        daily_rate, weekly_rate, deposit_amount, expected_return, expected_return_date,
        date_out, status, condition_out, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,NOW(),'out',$10,$11,$12) RETURNING *`,
      [tenantId, rentalNumber, product_id, customer_id, serial_number_id || null,
        parsedDailyRate, weekly_rate ? parseFloat(String(weekly_rate)) : null, parsedDeposit,
        expected_return_date || null, condition_out, notes, userId]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, rental: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/rentals/:id/return
router.put('/:id/return', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantId = req.user!.tenantId;
    const { condition_in, late_fees = 0, notes } = req.body;

    const rental = await client.query(
      `SELECT * FROM tool_rentals WHERE id = $1 AND tenant_id = $2 AND status = 'out'`,
      [req.params.id, tenantId]
    );
    if (!rental.rows.length) { res.status(404).json({ success: false, message: 'Active rental not found' }); return; }

    const r = rental.rows[0];
    const daysOut = Math.max(1, Math.ceil((Date.now() - new Date(r.date_out).getTime()) / (1000 * 60 * 60 * 24)));
    const totalCharged = daysOut * parseFloat(r.daily_rate) + parseFloat(late_fees);

    await client.query(
      `UPDATE tool_rentals SET
        status='returned', actual_return=NOW(), actual_return_date=NOW(),
        condition_in=$1, late_fees=$2, late_fees_charged=$2,
        total_amount=$3, total_charged=$3, total_days=$4, updated_at=NOW()
       WHERE id=$5`,
      [condition_in, late_fees, totalCharged, daysOut, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Return processed', totalCharged });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

export default router;
