import { Router, Response } from 'express';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// GET /api/serials
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, status, product_id, limit = '50', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let queryStr = `
      SELECT sn.*,
        p.name AS product_name, p.sku AS product_sku,
        c.name AS customer_name
      FROM serial_numbers sn
      LEFT JOIN products p ON p.id = sn.product_id
      LEFT JOIN customers c ON c.id = sn.customer_id
      WHERE sn.tenant_id = $1
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      queryStr += ` AND (sn.serial_number ILIKE $${params.length} OR COALESCE(p.name,'') ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      queryStr += ` AND sn.status = $${params.length}`;
    }
    if (product_id) {
      params.push(product_id);
      queryStr += ` AND sn.product_id = $${params.length}`;
    }

    queryStr += ` ORDER BY sn.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(queryStr, params);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM serial_numbers WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({ success: true, serials: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/serials — register single or bulk serials
router.post('/', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenantId = req.user!.tenantId;
    const { product_id, serial_numbers, condition = 'new', notes } = req.body;

    if (!product_id || !serial_numbers?.length) {
      res.status(400).json({ success: false, message: 'Product and at least one serial number are required' });
      return;
    }

    const inserted: any[] = [];
    for (const sn of serial_numbers) {
      const trimmed = String(sn).trim();
      if (!trimmed) continue;
      const result = await client.query(
        `INSERT INTO serial_numbers (tenant_id, product_id, serial_number, status, condition, notes)
         VALUES ($1,$2,$3,'available',$4,$5)
         ON CONFLICT (tenant_id, serial_number) DO NOTHING RETURNING *`,
        [tenantId, product_id, trimmed, condition, notes]
      );
      if (result.rows.length) inserted.push(result.rows[0]);
    }

    // Update inventory
    await client.query(
      `UPDATE inventory SET quantity_on_hand = quantity_on_hand + $1, updated_at=NOW()
       WHERE product_id = $2 AND tenant_id = $3`,
      [inserted.length, product_id, tenantId]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, inserted: inserted.length, serials: inserted });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/serials/:id/status
router.patch('/:id/status', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const { status, notes } = req.body;
    const validStatuses = ['available', 'sold', 'rented', 'damaged', 'returned'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, message: 'Invalid status' });
      return;
    }

    const result = await pool.query(
      `UPDATE serial_numbers SET status=$1, notes=COALESCE($2,notes), updated_at=NOW()
       WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [status, notes, req.params.id, tenantId]
    );

    if (!result.rows.length) {
      res.status(404).json({ success: false, message: 'Serial number not found' });
      return;
    }
    res.json({ success: true, serial: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
