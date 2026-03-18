import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router = Router();
router.use(authenticate, tenantContext, requireManager);

router.get('/sales-summary', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date, branch_id } = req.query;

    const params: any[] = [tenantId];
    let where = 'WHERE tenant_id = $1 AND status = \'completed\'';
    let i = 2;

    if (from_date) { where += ` AND sale_date >= $${i}`; params.push(from_date); i++; }
    if (to_date) { where += ` AND sale_date <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }
    if (branch_id) { where += ` AND branch_id = $${i}`; params.push(branch_id); i++; }

    const [summary, byPayment, byType, daily] = await Promise.all([
      query(`SELECT COUNT(*) as transactions, COALESCE(SUM(total_amount),0) as revenue, COALESCE(SUM(tax_amount),0) as tax, COALESCE(AVG(total_amount),0) as avg_sale FROM sales ${where}`, params),
      query(`SELECT p.payment_method, COUNT(*) as count, SUM(p.amount) as amount FROM payments p JOIN sales s ON s.id = p.sale_id ${where.replace('WHERE', 'WHERE s.')} GROUP BY p.payment_method ORDER BY amount DESC`, params),
      query(`SELECT sale_type, COUNT(*) as count, SUM(total_amount) as amount FROM sales ${where} GROUP BY sale_type`, params),
      query(`SELECT DATE(sale_date) as date, COUNT(*) as transactions, SUM(total_amount) as revenue FROM sales ${where} GROUP BY DATE(sale_date) ORDER BY date ASC`, params),
    ]);

    return res.json({ success: true, summary: summary.rows[0], byPayment: byPayment.rows, byType: byType.rows, daily: daily.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/inventory-valuation', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const result = await query(`
      SELECT c.name as category, 
        COUNT(p.id) as products,
        SUM(i.quantity_on_hand) as total_qty,
        SUM(i.quantity_on_hand * COALESCE(p.cost_price, p.retail_price)) as cost_value,
        SUM(i.quantity_on_hand * p.retail_price) as retail_value
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.tenant_id = $1 AND p.is_active = true
      GROUP BY c.name
      ORDER BY retail_value DESC NULLS LAST
    `, [tenantId]);

    return res.json({ success: true, valuation: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/top-products', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { days = 30 } = req.query;

    const result = await query(`
      SELECT p.name, p.sku, c.name as category, SUM(si.quantity) as qty_sold, SUM(si.total_price) as revenue
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = $1 AND s.status = 'completed'
        AND s.sale_date >= NOW() - INTERVAL '${Number(days)} days'
      JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      GROUP BY p.id, p.name, p.sku, c.name
      ORDER BY revenue DESC
      LIMIT 20
    `, [tenantId]);

    return res.json({ success: true, products: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/debtors', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(`
      SELECT c.id, c.name, c.company_name, c.phone, c.customer_type, c.current_balance, c.credit_limit,
        COUNT(s.id) as open_invoices
      FROM customers c
      LEFT JOIN sales s ON s.customer_id = c.id AND s.payment_status IN ('partial','pending')
      WHERE c.tenant_id = $1 AND c.current_balance > 0
      GROUP BY c.id, c.name, c.company_name, c.phone, c.customer_type, c.current_balance, c.credit_limit
      ORDER BY c.current_balance DESC
    `, [tenantId]);

    return res.json({ success: true, debtors: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
