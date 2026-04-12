import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext, requireManager);

// ── helper to write audit logs ────────────────────────────────────────────────
export async function writeAuditLog(
  tenantId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string,
  oldValues?: object | null,
  newValues?: object | null,
  ipAddress?: string,
) {
  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, old_values, new_values, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, userId, action, resourceType, resourceId || null,
       oldValues ? JSON.stringify(oldValues) : null,
       newValues ? JSON.stringify(newValues) : null,
       ipAddress || null],
    );
  } catch (_) { /* audit failures must never break main flow */ }
}

// ── SALES SUMMARY ─────────────────────────────────────────────────────────────
router.get('/sales-summary', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date, branch_id } = req.query;
    const params: any[] = [tenantId];
    let where = "WHERE s.tenant_id = $1 AND s.status = 'completed'";
    let i = 2;
    if (from_date) { where += ` AND s.sale_date >= $${i}`; params.push(from_date); i++; }
    if (to_date)   { where += ` AND s.sale_date <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }
    if (branch_id) { where += ` AND s.branch_id = $${i}`; params.push(branch_id); i++; }

    const [summary, byPayment, byType, daily, recentSales, topProducts] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as transactions,
          COALESCE(SUM(s.total_amount),0) as revenue,
          COALESCE(SUM(s.tax_amount),0) as tax,
          COALESCE(AVG(s.total_amount),0) as avg_sale
        FROM sales s ${where}
      `, params),

      // Fix: fully qualify all columns to avoid ambiguity with payments.status
      query(`
        SELECT p.payment_method, COUNT(*) as count, COALESCE(SUM(p.amount),0) as amount
        FROM payments p
        JOIN sales s ON s.id = p.sale_id
        ${where}
        GROUP BY p.payment_method ORDER BY amount DESC
      `, params),

      query(`
        SELECT s.sale_type, COUNT(*) as count, COALESCE(SUM(s.total_amount),0) as amount
        FROM sales s ${where} GROUP BY s.sale_type
      `, params),

      query(`
        SELECT DATE(s.sale_date) as date,
          COUNT(*) as transactions,
          COALESCE(SUM(s.total_amount),0) as revenue
        FROM sales s ${where} GROUP BY DATE(s.sale_date) ORDER BY date ASC
      `, params),

      // Recent 50 sales for the period
      query(`
        SELECT s.sale_number, s.sale_date, s.customer_name, s.sale_type,
          s.total_amount, s.payment_status, s.status,
          u.first_name || ' ' || u.last_name as cashier_name,
          b.name as branch_name
        FROM sales s
        LEFT JOIN users u ON u.id = s.cashier_id
        LEFT JOIN branches b ON b.id = s.branch_id
        ${where}
        ORDER BY s.sale_date DESC LIMIT 50
      `, params),

      // Top 10 products for the period
      query(`
        SELECT p.name, p.sku,
          SUM(si.quantity) as qty_sold,
          COALESCE(SUM(si.total_price),0) as revenue
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        ${where}
        GROUP BY p.id, p.name, p.sku ORDER BY revenue DESC LIMIT 10
      `, params),
    ]);

    return res.json({
      success: true,
      summary: summary.rows[0],
      byPayment: byPayment.rows,
      byType: byType.rows,
      daily: daily.rows,
      recentSales: recentSales.rows,
      topProducts: topProducts.rows,
    });
  } catch (error) {
    console.error('sales-summary error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── INVENTORY VALUATION ───────────────────────────────────────────────────────
router.get('/inventory-valuation', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const [valuation, lowStock, totals] = await Promise.all([
      query(`
        SELECT c.name as category, COUNT(p.id) as products,
          COALESCE(SUM(i.quantity_on_hand),0) as total_qty,
          COALESCE(SUM(i.quantity_on_hand * COALESCE(p.cost_price, p.retail_price)),0) as cost_value,
          COALESCE(SUM(i.quantity_on_hand * p.retail_price),0) as retail_value
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.tenant_id = $1 AND p.is_active = true
        GROUP BY c.name ORDER BY retail_value DESC NULLS LAST
      `, [tenantId]),

      query(`
        SELECT p.name, p.sku, c.name as category,
          COALESCE(i.quantity_on_hand,0) as qty_on_hand,
          COALESCE(p.reorder_level,0) as reorder_point,
          p.retail_price
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.tenant_id = $1 AND p.is_active = true
          AND COALESCE(i.quantity_on_hand,0) <= COALESCE(p.reorder_level, 5)
        ORDER BY i.quantity_on_hand ASC NULLS FIRST LIMIT 30
      `, [tenantId]),

      query(`
        SELECT
          COUNT(p.id) as total_products,
          COUNT(CASE WHEN COALESCE(i.quantity_on_hand,0) <= 0 THEN 1 END) as out_of_stock,
          COUNT(CASE WHEN COALESCE(i.quantity_on_hand,0) > 0
            AND COALESCE(i.quantity_on_hand,0) <= COALESCE(p.reorder_level,5) THEN 1 END) as low_stock
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.is_active = true
      `, [tenantId]),
    ]);

    return res.json({ success: true, valuation: valuation.rows, lowStock: lowStock.rows, totals: totals.rows[0] });
  } catch (error) {
    console.error('inventory-valuation error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── TOP PRODUCTS ──────────────────────────────────────────────────────────────
router.get('/top-products', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { days = 30 } = req.query;
    const result = await query(`
      SELECT p.name, p.sku, c.name as category,
        SUM(si.quantity) as qty_sold,
        COALESCE(SUM(si.total_price),0) as revenue
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = $1
        AND s.status = 'completed'
        AND s.sale_date >= NOW() - INTERVAL '${Number(days)} days'
      JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      GROUP BY p.id, p.name, p.sku, c.name ORDER BY revenue DESC LIMIT 20
    `, [tenantId]);
    return res.json({ success: true, products: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DEBTORS ───────────────────────────────────────────────────────────────────
router.get('/debtors', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const [debtors, aging] = await Promise.all([
      query(`
        SELECT c.id, c.name, c.company_name, c.phone, c.customer_type,
          c.current_balance, c.credit_limit,
          COUNT(s.id) as open_invoices,
          MIN(s.sale_date) as oldest_invoice_date
        FROM customers c
        LEFT JOIN sales s ON s.customer_id = c.id
          AND s.payment_status IN ('partial','pending','credit')
        WHERE c.tenant_id = $1 AND c.current_balance > 0
        GROUP BY c.id, c.name, c.company_name, c.phone, c.customer_type,
          c.current_balance, c.credit_limit
        ORDER BY c.current_balance DESC
      `, [tenantId]),

      query(`
        SELECT
          SUM(CASE WHEN NOW() - s.sale_date <= INTERVAL '30 days' THEN s.balance_due ELSE 0 END) as age_0_30,
          SUM(CASE WHEN NOW() - s.sale_date BETWEEN INTERVAL '31 days' AND INTERVAL '60 days' THEN s.balance_due ELSE 0 END) as age_31_60,
          SUM(CASE WHEN NOW() - s.sale_date BETWEEN INTERVAL '61 days' AND INTERVAL '90 days' THEN s.balance_due ELSE 0 END) as age_61_90,
          SUM(CASE WHEN NOW() - s.sale_date > INTERVAL '90 days' THEN s.balance_due ELSE 0 END) as age_90_plus,
          COALESCE(SUM(s.balance_due),0) as total_outstanding
        FROM sales s
        JOIN customers c ON c.id = s.customer_id
        WHERE s.tenant_id = $1 AND s.payment_status IN ('partial','pending','credit')
          AND s.balance_due > 0
      `, [tenantId]),
    ]);

    return res.json({ success: true, debtors: debtors.rows, aging: aging.rows[0] });
  } catch (error) {
    console.error('debtors error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── RENTALS ───────────────────────────────────────────────────────────────────
router.get('/rentals', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date } = req.query;
    const params: any[] = [tenantId];
    let where = 'WHERE tr.tenant_id = $1';
    let i = 2;
    if (from_date) { where += ` AND tr.date_out >= $${i}`; params.push(from_date); i++; }
    if (to_date)   { where += ` AND tr.date_out <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }

    const [summary, byProduct, daily, overdueList] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_rentals,
          SUM(CASE WHEN tr.status='out' THEN 1 ELSE 0 END) as active_rentals,
          SUM(CASE WHEN tr.status='returned' THEN 1 ELSE 0 END) as returned_rentals,
          SUM(CASE WHEN tr.status='out'
            AND COALESCE(tr.expected_return_date, tr.expected_return) < NOW() THEN 1 ELSE 0 END) as overdue_rentals,
          COALESCE(SUM(tr.total_amount),0) as total_revenue,
          COALESCE(SUM(tr.deposit_amount),0) as total_deposits,
          COALESCE(SUM(tr.late_fees_charged),0) as total_late_fees
        FROM tool_rentals tr ${where}
      `, params),

      query(`
        SELECT p.name as product_name, COUNT(*) as rental_count,
          COALESCE(SUM(tr.total_amount),0) as revenue
        FROM tool_rentals tr
        LEFT JOIN products p ON p.id = tr.product_id
        ${where} GROUP BY p.name ORDER BY rental_count DESC LIMIT 10
      `, params),

      query(`
        SELECT DATE(tr.date_out) as date, COUNT(*) as rentals,
          COALESCE(SUM(tr.total_amount),0) as revenue
        FROM tool_rentals tr ${where}
        GROUP BY DATE(tr.date_out) ORDER BY date ASC
      `, params),

      // Overdue rentals detail
      query(`
        SELECT tr.id, p.name as product_name, c.name as customer_name, c.phone,
          tr.date_out, COALESCE(tr.expected_return_date, tr.expected_return) as due_date,
          tr.deposit_amount, tr.total_amount
        FROM tool_rentals tr
        LEFT JOIN products p ON p.id = tr.product_id
        LEFT JOIN customers c ON c.id = tr.customer_id
        WHERE tr.tenant_id = $1 AND tr.status = 'out'
          AND COALESCE(tr.expected_return_date, tr.expected_return) < NOW()
        ORDER BY due_date ASC LIMIT 20
      `, [tenantId]),
    ]);

    return res.json({
      success: true,
      summary: summary.rows[0],
      byProduct: byProduct.rows,
      daily: daily.rows,
      overdueList: overdueList.rows,
    });
  } catch (error) {
    console.error('rentals error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── CUTTING ───────────────────────────────────────────────────────────────────
router.get('/cutting', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date } = req.query;
    const params: any[] = [tenantId];
    let where = 'WHERE cl.tenant_id = $1';
    let i = 2;
    if (from_date) { where += ` AND cl.created_at >= $${i}`; params.push(from_date); i++; }
    if (to_date)   { where += ` AND cl.created_at <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }

    const [summary, byProduct, daily, recentJobs] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_jobs,
          COALESCE(SUM(cut_quantity_requested),0) as total_cut_qty,
          COALESCE(SUM(waste_amount),0) as total_waste,
          COALESCE(AVG(CASE WHEN cut_quantity_requested > 0 THEN (waste_amount/cut_quantity_requested)*100 ELSE 0 END),0) as avg_waste_pct,
          COALESCE(SUM(cutting_charge),0) as total_revenue
        FROM cutting_log cl ${where}
      `, params),

      query(`
        SELECT p.name as product_name, COUNT(*) as job_count,
          COALESCE(SUM(cl.cut_quantity_requested),0) as total_qty,
          COALESCE(SUM(cl.cutting_charge),0) as revenue
        FROM cutting_log cl LEFT JOIN products p ON p.id = cl.product_id
        ${where} GROUP BY p.name ORDER BY job_count DESC LIMIT 10
      `, params),

      query(`
        SELECT DATE(cl.created_at) as date, COUNT(*) as jobs,
          COALESCE(SUM(cl.cutting_charge),0) as revenue
        FROM cutting_log cl ${where}
        GROUP BY DATE(cl.created_at) ORDER BY date ASC
      `, params),

      query(`
        SELECT cl.created_at, p.name as product_name,
          cl.cut_quantity_requested, cl.waste_amount, cl.cutting_charge,
          cl.customer_name,
          u.first_name || ' ' || u.last_name as operator_name
        FROM cutting_log cl
        LEFT JOIN products p ON p.id = cl.product_id
        LEFT JOIN users u ON u.id = cl.operator_id
        ${where} ORDER BY cl.created_at DESC LIMIT 30
      `, params),
    ]);

    return res.json({
      success: true,
      summary: summary.rows[0],
      byProduct: byProduct.rows,
      daily: daily.rows,
      recentJobs: recentJobs.rows,
    });
  } catch (error) {
    console.error('cutting error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PURCHASES ─────────────────────────────────────────────────────────────────
router.get('/purchases', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date } = req.query;
    const params: any[] = [tenantId];
    let where = 'WHERE po.tenant_id = $1';
    let i = 2;
    if (from_date) { where += ` AND po.created_at >= $${i}`; params.push(from_date); i++; }
    if (to_date)   { where += ` AND po.created_at <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }

    const [summary, bySupplier, byStatus, recentPOs] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_pos,
          SUM(CASE WHEN po.status='draft' THEN 1 ELSE 0 END) as draft_pos,
          SUM(CASE WHEN po.status='received' THEN 1 ELSE 0 END) as received_pos,
          SUM(CASE WHEN po.status='ordered' THEN 1 ELSE 0 END) as ordered_pos,
          COALESCE(SUM(po.total_amount),0) as total_value,
          COALESCE(SUM(CASE WHEN po.status='received' THEN po.total_amount ELSE 0 END),0) as received_value
        FROM purchase_orders po ${where}
      `, params),

      query(`
        SELECT s.name as supplier_name, COUNT(po.id) as po_count,
          COALESCE(SUM(po.total_amount),0) as total_value
        FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
        ${where} GROUP BY s.name ORDER BY total_value DESC LIMIT 10
      `, params),

      query(`
        SELECT po.status, COUNT(*) as count,
          COALESCE(SUM(po.total_amount),0) as value
        FROM purchase_orders po ${where} GROUP BY po.status ORDER BY count DESC
      `, params),

      query(`
        SELECT po.po_number, po.created_at, po.status, po.total_amount,
          s.name as supplier_name,
          u.first_name || ' ' || u.last_name as created_by
        FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id
        LEFT JOIN users u ON u.id = po.created_by
        ${where} ORDER BY po.created_at DESC LIMIT 30
      `, params),
    ]);

    return res.json({
      success: true,
      summary: summary.rows[0],
      bySupplier: bySupplier.rows,
      byStatus: byStatus.rows,
      recentPOs: recentPOs.rows,
    });
  } catch (error) {
    console.error('purchases error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── EXPENSES ──────────────────────────────────────────────────────────────────
router.get('/expenses', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date } = req.query;
    const params: any[] = [tenantId];
    let where = 'WHERE e.tenant_id = $1';
    let i = 2;
    if (from_date) { where += ` AND e.expense_date >= $${i}`; params.push(from_date); i++; }
    if (to_date)   { where += ` AND e.expense_date <= $${i}`; params.push(to_date); i++; }

    const [summary, byCategory, recentExpenses, daily] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total_expenses,
          COALESCE(SUM(e.amount),0) as total_amount,
          COALESCE(AVG(e.amount),0) as avg_amount,
          COALESCE(MAX(e.amount),0) as max_amount
        FROM expenses e ${where}
      `, params),

      query(`
        SELECT e.category, COUNT(*) as count,
          COALESCE(SUM(e.amount),0) as total
        FROM expenses e ${where} GROUP BY e.category ORDER BY total DESC
      `, params),

      query(`
        SELECT e.expense_date, e.category, e.description, e.amount,
          u.first_name || ' ' || u.last_name as recorded_by
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        ${where} ORDER BY e.expense_date DESC LIMIT 30
      `, params),

      query(`
        SELECT e.expense_date as date,
          COALESCE(SUM(e.amount),0) as total
        FROM expenses e ${where}
        GROUP BY e.expense_date ORDER BY e.expense_date ASC
      `, params),
    ]);

    return res.json({
      success: true,
      summary: summary.rows[0],
      byCategory: byCategory.rows,
      recentExpenses: recentExpenses.rows,
      daily: daily.rows,
    });
  } catch (error) {
    console.error('expenses error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── AUDIT LOGS ────────────────────────────────────────────────────────────────
router.get('/audit-logs', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { from_date, to_date, user_id, resource_type, page = 1 } = req.query;
    const limit = 50;
    const offset = (Number(page) - 1) * limit;

    const params: any[] = [tenantId];
    let where = 'WHERE al.tenant_id = $1';
    let i = 2;

    if (from_date)     { where += ` AND al.created_at >= $${i}`; params.push(from_date); i++; }
    if (to_date)       { where += ` AND al.created_at <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }
    if (user_id)       { where += ` AND al.user_id = $${i}`; params.push(user_id); i++; }
    if (resource_type) { where += ` AND al.resource_type = $${i}`; params.push(resource_type); i++; }

    const [logs, countRes, users] = await Promise.all([
      query(`
        SELECT al.id, al.action, al.resource_type, al.resource_id,
          al.old_values, al.new_values, al.ip_address, al.created_at,
          u.first_name || ' ' || u.last_name as user_name,
          u.email as user_email, u.role as user_role
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.user_id
        ${where}
        ORDER BY al.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, [...params, limit, offset]),

      query(`SELECT COUNT(*) FROM audit_logs al ${where}`, params),

      // Distinct users who have actions (for filter dropdown)
      query(`
        SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name as name, u.role
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = $1 AND u.id IS NOT NULL
        ORDER BY name
      `, [tenantId]),
    ]);

    return res.json({
      success: true,
      logs: logs.rows,
      total: parseInt(countRes.rows[0].count),
      page: Number(page),
      pages: Math.ceil(parseInt(countRes.rows[0].count) / limit),
      users: users.rows,
    });
  } catch (error) {
    console.error('audit-logs error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
