import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { page = 1, limit = 20, search = '', type = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = 'WHERE tenant_id = $1';
    const params: any[] = [tenantId];
    let i = 2;

    if (search) { where += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR email ILIKE $${i} OR company_name ILIKE $${i})`; params.push(`%${search}%`); i++; }
    if (type) { where += ` AND customer_type = $${i}`; params.push(type); i++; }

    const countRes = await query(`SELECT COUNT(*) FROM customers ${where}`, params);
    const result = await query(`SELECT * FROM customers ${where} ORDER BY name ASC LIMIT $${i} OFFSET $${i+1}`, [...params, Number(limit), offset]);

    return res.json({ success: true, customers: result.rows, pagination: { total: parseInt(countRes.rows[0].count), page: Number(page), limit: Number(limit) } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [req.params.id, req.user!.tenantId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Customer not found' });

    const sales = await query(`SELECT id, sale_number, sale_date, total_amount, payment_status FROM sales WHERE customer_id = $1 ORDER BY sale_date DESC LIMIT 10`, [req.params.id]);

    return res.json({ success: true, customer: result.rows[0], recentSales: sales.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { name, email, phone, phone2, address, city, customer_type, company_name, trade_license_no, kra_pin, credit_limit, discount_tier, discount_percentage, notes } = req.body;

    const countRes = await query('SELECT COUNT(*) FROM customers WHERE tenant_id = $1', [tenantId]);
    const count = parseInt(countRes.rows[0].count) + 1;
    const customerNumber = `CUST-${String(count).padStart(5, '0')}`;

    const result = await query(`
      INSERT INTO customers (tenant_id, customer_number, name, email, phone, phone2, address, city, customer_type, company_name, trade_license_no, kra_pin, credit_limit, discount_tier, discount_percentage, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *
    `, [tenantId, customerNumber, name, email, phone, phone2, address, city, customer_type || 'retail', company_name, trade_license_no, kra_pin, credit_limit || 0, discount_tier || 'none', discount_percentage || 0, notes, req.user!.id]);

    return res.status(201).json({ success: true, customer: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, phone2, address, city, customer_type, company_name, trade_license_no, kra_pin, credit_limit, discount_tier, discount_percentage, notes, status } = req.body;
    const result = await query(`
      UPDATE customers SET name=$1,email=$2,phone=$3,phone2=$4,address=$5,city=$6,customer_type=$7,company_name=$8,trade_license_no=$9,kra_pin=$10,credit_limit=$11,discount_tier=$12,discount_percentage=$13,notes=$14,status=$15,updated_at=NOW()
      WHERE id=$16 AND tenant_id=$17 RETURNING *
    `, [name,email,phone,phone2,address,city,customer_type,company_name,trade_license_no,kra_pin,credit_limit,discount_tier,discount_percentage,notes,status,req.params.id,req.user!.tenantId]);
    return res.json({ success: true, customer: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
