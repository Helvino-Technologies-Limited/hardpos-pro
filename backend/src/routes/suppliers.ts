import { Router, Response } from 'express';
import { authenticate, requireManager, requireAdmin, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// GET /api/suppliers
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, limit = '100', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let query = `
      SELECT s.*,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS po_count
      FROM suppliers s
      WHERE s.tenant_id = $1 AND s.is_active = true
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (s.name ILIKE $${params.length} OR COALESCE(s.contact_person,'') ILIKE $${params.length} OR COALESCE(s.email,'') ILIKE $${params.length} OR COALESCE(s.city,'') ILIKE $${params.length})`;
    }

    query += ` ORDER BY s.name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM suppliers WHERE tenant_id = $1 AND is_active = true', [tenantId]);

    res.json({ success: true, suppliers: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/suppliers/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pool.query(
      'SELECT * FROM suppliers WHERE id = $1 AND tenant_id = $2 AND is_active = true',
      [req.params.id, tenantId]
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Supplier not found' }); return; }
    res.json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/suppliers
router.post('/', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const { name, contact_person, email, phone, address, city, country = 'Kenya', supplier_type = 'distributor', payment_terms = 'net_30', credit_limit = 0, kra_pin, bank_name, bank_account, notes } = req.body;

    if (!name) { res.status(400).json({ success: false, message: 'Supplier name is required' }); return; }

    const result = await pool.query(
      `INSERT INTO suppliers (tenant_id, name, contact_person, email, phone, address, city, country,
        supplier_type, payment_terms, credit_limit, kra_pin, bank_name, bank_account, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [tenantId, name, contact_person, email, phone, address, city, country,
        supplier_type, payment_terms, credit_limit, kra_pin, bank_name, bank_account, notes]
    );

    res.status(201).json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/suppliers/:id
router.put('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const { name, contact_person, email, phone, address, city, supplier_type, payment_terms, credit_limit, kra_pin, bank_name, bank_account, notes } = req.body;

    const result = await pool.query(
      `UPDATE suppliers SET name=$1, contact_person=$2, email=$3, phone=$4, address=$5, city=$6,
        supplier_type=$7, payment_terms=$8, credit_limit=$9, kra_pin=$10, bank_name=$11,
        bank_account=$12, notes=$13, updated_at=NOW()
       WHERE id=$14 AND tenant_id=$15 RETURNING *`,
      [name, contact_person, email, phone, address, city, supplier_type, payment_terms,
        credit_limit, kra_pin, bank_name, bank_account, notes, req.params.id, tenantId]
    );

    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Supplier not found' }); return; }
    res.json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/suppliers/:id
router.delete('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    await pool.query('UPDATE suppliers SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
    res.json({ success: true, message: 'Supplier deactivated' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
