import { Router, Response } from 'express';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

async function ensureExpenseTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        expense_number VARCHAR(50),
        category VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'cash',
        reference VARCHAR(255),
        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
        approved_by UUID,
        recorded_by UUID,
        receipt_url TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`);
  } catch (_) {}
}
ensureExpenseTable();

// GET /api/expenses
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, category, from_date, to_date, limit = '50', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let queryStr = `
      SELECT e.*,
        u.first_name || ' ' || u.last_name AS recorded_by_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.recorded_by
      WHERE e.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      queryStr += ` AND (e.description ILIKE $${params.length} OR e.category ILIKE $${params.length} OR COALESCE(e.reference,'') ILIKE $${params.length})`;
    }
    if (category) {
      params.push(category);
      queryStr += ` AND e.category = $${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      queryStr += ` AND e.expense_date >= $${params.length}`;
    }
    if (to_date) {
      params.push(to_date);
      queryStr += ` AND e.expense_date <= $${params.length}`;
    }

    queryStr += ` ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const [result, total, summary] = await Promise.all([
      pool.query(queryStr, params),
      pool.query('SELECT COUNT(*) FROM expenses WHERE tenant_id = $1', [tenantId]),
      pool.query(
        `SELECT category, COUNT(*) as count, SUM(amount) as total
         FROM expenses WHERE tenant_id = $1
         GROUP BY category ORDER BY total DESC`,
        [tenantId]
      ),
    ]);

    res.json({
      success: true,
      expenses: result.rows,
      total: parseInt(total.rows[0].count),
      summary: summary.rows,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/expenses
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    const { category, description, amount, payment_method = 'cash', reference, expense_date, notes } = req.body;

    if (!category || !description || !amount) {
      res.status(400).json({ success: false, message: 'Category, description and amount are required' });
      return;
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM expenses WHERE tenant_id = $1', [tenantId]);
    const expNumber = `EXP-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;

    const result = await pool.query(
      `INSERT INTO expenses (tenant_id, expense_number, category, description, amount, payment_method, reference, expense_date, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tenantId, expNumber, category, description, parseFloat(amount), payment_method, reference, expense_date || new Date().toISOString().split('T')[0], notes, userId]
    );

    res.status(201).json({ success: true, expense: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/expenses/:id
router.put('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const { category, description, amount, payment_method, reference, expense_date, notes } = req.body;

    const result = await pool.query(
      `UPDATE expenses SET category=$1, description=$2, amount=$3, payment_method=$4, reference=$5,
        expense_date=$6, notes=$7, updated_at=NOW()
       WHERE id=$8 AND tenant_id=$9 RETURNING *`,
      [category, description, amount, payment_method, reference, expense_date, notes, req.params.id, tenantId]
    );

    if (!result.rows.length) {
      res.status(404).json({ success: false, message: 'Expense not found' });
      return;
    }
    res.json({ success: true, expense: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    await pool.query('DELETE FROM expenses WHERE id=$1 AND tenant_id=$2', [req.params.id, tenantId]);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
