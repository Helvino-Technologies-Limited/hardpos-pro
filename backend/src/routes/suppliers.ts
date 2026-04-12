import { Router, Response } from 'express';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';
import pool from '../config/database';

const router: Router = Router();
router.use(authenticate, tenantContext);

// GET /api/suppliers
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { search, limit = '100', offset = '0' } = req.query as any;
    const tenantId = req.user!.tenantId;

    let q = `
      SELECT s.*,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS po_count
      FROM suppliers s
      WHERE s.tenant_id = $1 AND s.status = 'active'
    `;
    const params: any[] = [tenantId];

    if (search) {
      params.push(`%${search}%`);
      q += ` AND (s.name ILIKE $${params.length}
               OR COALESCE(s.contact_person,'') ILIKE $${params.length}
               OR COALESCE(s.email,'')         ILIKE $${params.length}
               OR COALESCE(s.city,'')          ILIKE $${params.length})`;
    }

    q += ` ORDER BY s.name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result      = await pool.query(q, params);
    const countResult = await pool.query(
      "SELECT COUNT(*) FROM suppliers WHERE tenant_id = $1 AND status = 'active'",
      [tenantId],
    );

    res.json({ success: true, suppliers: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err: any) {
    console.error('suppliers GET error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/suppliers/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await pool.query(
      "SELECT * FROM suppliers WHERE id = $1 AND tenant_id = $2 AND status = 'active'",
      [req.params.id, tenantId],
    );
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Supplier not found' }); return; }
    res.json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    console.error('suppliers GET/:id error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/suppliers
router.post('/', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      name, contact_person, email, phone, address, city, kra_pin,
      supplier_type = 'distributor',
      payment_terms = 30,          // INT — number of days
      credit_limit = 0,
      bank_name, bank_account,     // stored inside bank_details JSONB
      notes,
    } = req.body;

    if (!name) { res.status(400).json({ success: false, message: 'Supplier name is required' }); return; }

    // Build bank_details JSONB from optional bank fields
    const bankDetails = (bank_name || bank_account)
      ? JSON.stringify({ bank_name: bank_name || '', account: bank_account || '' })
      : '{}';

    const result = await pool.query(
      `INSERT INTO suppliers
         (tenant_id, name, contact_person, email, phone, address, city, kra_pin,
          supplier_type, payment_terms, credit_limit, bank_details, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
       RETURNING *`,
      [
        tenantId, name, contact_person || null, email || null, phone || null,
        address || null, city || null, kra_pin || null,
        supplier_type, parseInt(String(payment_terms)) || 30,
        parseFloat(String(credit_limit)) || 0,
        bankDetails, notes || null,
      ],
    );

    res.status(201).json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    console.error('suppliers POST error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/suppliers/:id
router.put('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      name, contact_person, email, phone, address, city, kra_pin,
      supplier_type, payment_terms, credit_limit,
      bank_name, bank_account,
      notes,
    } = req.body;

    const bankDetails = (bank_name || bank_account)
      ? JSON.stringify({ bank_name: bank_name || '', account: bank_account || '' })
      : '{}';

    const result = await pool.query(
      `UPDATE suppliers
       SET name=$1, contact_person=$2, email=$3, phone=$4, address=$5, city=$6, kra_pin=$7,
           supplier_type=$8, payment_terms=$9, credit_limit=$10, bank_details=$11,
           notes=$12, updated_at=NOW()
       WHERE id=$13 AND tenant_id=$14
       RETURNING *`,
      [
        name, contact_person || null, email || null, phone || null,
        address || null, city || null, kra_pin || null,
        supplier_type, parseInt(String(payment_terms)) || 30,
        parseFloat(String(credit_limit)) || 0,
        bankDetails, notes || null,
        req.params.id, tenantId,
      ],
    );

    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Supplier not found' }); return; }
    res.json({ success: true, supplier: result.rows[0] });
  } catch (err: any) {
    console.error('suppliers PUT error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/suppliers/:id  (soft-delete via status)
router.delete('/:id', requireManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId;
    await pool.query(
      "UPDATE suppliers SET status = 'inactive', updated_at = NOW() WHERE id = $1 AND tenant_id = $2",
      [req.params.id, tenantId],
    );
    res.json({ success: true, message: 'Supplier deactivated' });
  } catch (err: any) {
    console.error('suppliers DELETE error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
