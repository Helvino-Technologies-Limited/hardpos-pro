import { Router, Response } from 'express';
import { query, getClient } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router = Router();
router.use(authenticate, tenantContext);

const generateSaleNumber = (branchCode: string) => {
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  const rand = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  return `${branchCode}-${dateStr}-${rand}`;
};

// GET /api/sales
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { page = 1, limit = 20, search = '', status = '', from_date = '', to_date = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = 'WHERE s.tenant_id = $1';
    const params: any[] = [tenantId];
    let i = 2;

    if (search) { where += ` AND (s.sale_number ILIKE $${i} OR c.name ILIKE $${i} OR s.customer_name ILIKE $${i})`; params.push(`%${search}%`); i++; }
    if (status) { where += ` AND s.status = $${i}`; params.push(status); i++; }
    if (from_date) { where += ` AND s.sale_date >= $${i}`; params.push(from_date); i++; }
    if (to_date) { where += ` AND s.sale_date <= $${i}`; params.push(to_date + 'T23:59:59'); i++; }

    const countRes = await query(`SELECT COUNT(*) FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const result = await query(`
      SELECT s.*, 
        c.name as customer_name_full, c.phone as customer_phone, c.customer_type,
        u.first_name || ' ' || u.last_name as cashier_name,
        b.name as branch_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.cashier_id
      LEFT JOIN branches b ON b.id = s.branch_id
      ${where}
      ORDER BY s.sale_date DESC
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, Number(limit), offset]);

    return res.json({ success: true, sales: result.rows, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/sales/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const saleResult = await query(`
      SELECT s.*, c.name as customer_name_full, c.phone as customer_phone, c.kra_pin,
        u.first_name || ' ' || u.last_name as cashier_name,
        b.name as branch_name, b.address as branch_address, b.phone as branch_phone
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.cashier_id
      LEFT JOIN branches b ON b.id = s.branch_id
      WHERE s.id = $1 AND s.tenant_id = $2
    `, [req.params.id, req.user!.tenantId]);

    if (!saleResult.rows.length) return res.status(404).json({ success: false, message: 'Sale not found' });

    const itemsResult = await query(`
      SELECT si.*, p.name as product_name_official, p.barcode
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
    `, [req.params.id]);

    const paymentsResult = await query('SELECT * FROM payments WHERE sale_id = $1', [req.params.id]);

    return res.json({ success: true, sale: saleResult.rows[0], items: itemsResult.rows, payments: paymentsResult.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/sales
router.post('/', async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const tenantId = req.user!.tenantId;
    const {
      customer_id, customer_name, branch_id, sale_type, items, payments,
      discount_amount, notes, lpo_number, project_code,
      delivery_required, delivery_address, delivery_date
    } = req.body;

    // Get branch code
    const branchResult = await client.query('SELECT code FROM branches WHERE id = $1', [branch_id]);
    const branchCode = branchResult.rows[0]?.code || 'MAIN';
    const saleNumber = generateSaleNumber(branchCode);

    // Calculate totals
    let subtotal = 0;
    let taxAmount = 0;

    for (const item of items) {
      const itemTotal = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
      // Use nullish check — tax_rate=0 is valid (exempt), don't fall back to 16
      const effectiveTaxRate = (item.tax_rate != null && item.tax_rate !== '') ? Number(item.tax_rate) : 16;
      const itemTax = effectiveTaxRate === 0 ? 0 : itemTotal * (effectiveTaxRate / 100);
      subtotal += itemTotal;
      taxAmount += itemTax;
    }

    const discountAmt = discount_amount || 0;
    const totalAmount = Math.round((subtotal + taxAmount - discountAmt) * 100) / 100;
    const amountPaid = payments ? Math.round(payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0) * 100) / 100 : totalAmount;
    // Round to cents before comparing to avoid float drift marking full payments as partial
    const balanceDue = Math.max(0, Math.round((totalAmount - amountPaid) * 100) / 100);
    const paymentStatus = balanceDue === 0 ? 'paid' : amountPaid > 0 ? 'partial' : 'pending';

    // Insert sale
    const saleResult = await client.query(`
      INSERT INTO sales (
        tenant_id, branch_id, sale_number, customer_id, customer_name, cashier_id,
        status, sale_type, subtotal, discount_amount, tax_amount, total_amount,
        amount_paid, change_given, balance_due, payment_status,
        notes, lpo_number, project_code, delivery_required, delivery_address, delivery_date
      ) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      tenantId, branch_id, saleNumber, customer_id, customer_name, req.user!.id,
      sale_type || 'retail', subtotal, discountAmt, taxAmount, totalAmount,
      amountPaid, Math.max(0, amountPaid - totalAmount), Math.max(0, balanceDue), paymentStatus,
      notes, lpo_number, project_code, delivery_required || false, delivery_address, delivery_date
    ]);

    const sale = saleResult.rows[0];

    // Insert sale items & update inventory
    for (const item of items) {
      const itemTotal = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
      const effectiveTaxRate = (item.tax_rate != null && item.tax_rate !== '') ? Number(item.tax_rate) : 16;
      const itemTax = effectiveTaxRate === 0 ? 0 : itemTotal * (effectiveTaxRate / 100);

      await client.query(`
        INSERT INTO sale_items (
          sale_id, product_id, product_name, quantity, unit_of_measure,
          unit_price, discount_percent, discount_amount, tax_rate, tax_amount, total_price,
          serial_number_id, batch_id, is_cut_to_size, cut_instructions, notes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        sale.id, item.product_id, item.product_name, item.quantity, item.unit_of_measure,
        item.unit_price, item.discount_percent || 0, itemTotal * ((item.discount_percent || 0) / 100),
        effectiveTaxRate, itemTax, itemTotal + itemTax,
        item.serial_number_id, item.batch_id, item.is_cut_to_size || false, item.cut_instructions, item.notes
      ]);

      // Update inventory
      await client.query(`
        UPDATE inventory SET 
          quantity_on_hand = quantity_on_hand - $1,
          updated_at = NOW()
        WHERE product_id = $2 AND branch_id = $3 AND tenant_id = $4
      `, [item.quantity, item.product_id, branch_id, tenantId]);

      // Update serial if provided
      if (item.serial_number_id) {
        await client.query(`
          UPDATE serial_numbers SET status = 'sold', date_sold = NOW(), customer_id = $1, sale_id = $2
          WHERE id = $3
        `, [customer_id, sale.id, item.serial_number_id]);
      }
    }

    // Insert payments
    if (payments && payments.length) {
      for (const p of payments) {
        await client.query(`
          INSERT INTO payments (tenant_id, sale_id, customer_id, payment_method, amount, reference_number, mpesa_transaction_id, mpesa_phone, status, processed_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9)
        `, [tenantId, sale.id, customer_id, p.payment_method, p.amount, p.reference_number, p.mpesa_transaction_id, p.mpesa_phone, req.user!.id]);
      }
    }

    // Update customer balance if credit
    if (balanceDue > 0 && customer_id) {
      await client.query('UPDATE customers SET current_balance = current_balance + $1 WHERE id = $2', [balanceDue, customer_id]);
    }

    await client.query('COMMIT');

    // Return items + payments for receipt generation
    const itemsForReceipt = await query(
      'SELECT product_name, quantity, unit_of_measure, unit_price, discount_percent, tax_rate, total_price FROM sale_items WHERE sale_id = $1',
      [sale.id]
    );
    const paymentsForReceipt = await query(
      'SELECT payment_method, amount, reference_number FROM payments WHERE sale_id = $1',
      [sale.id]
    );

    return res.status(201).json({
      success: true,
      sale,
      items: itemsForReceipt.rows,
      payments: paymentsForReceipt.rows,
      message: 'Sale completed',
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Sale error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// GET /api/sales/dashboard/summary
router.get('/dashboard/summary', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const [todaySales, monthSales, lowStock, pendingOrders] = await Promise.all([
      query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as revenue, COALESCE(SUM(total_amount) FILTER (WHERE sale_type='trade'),0) as trade_revenue
             FROM sales WHERE tenant_id=$1 AND DATE(sale_date)=CURRENT_DATE AND status='completed'`, [tenantId]),
      query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as revenue FROM sales WHERE tenant_id=$1 AND sale_date>=DATE_TRUNC('month',NOW()) AND status='completed'`, [tenantId]),
      query(`SELECT p.id, p.name, p.reorder_level, COALESCE(SUM(i.quantity_on_hand),0) as stock
             FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.tenant_id=p.tenant_id
             WHERE p.tenant_id=$1 AND p.is_active=true GROUP BY p.id,p.name,p.reorder_level
             HAVING COALESCE(SUM(i.quantity_on_hand),0) <= p.reorder_level AND p.reorder_level > 0 LIMIT 10`, [tenantId]),
      query(`SELECT COUNT(*) as count FROM purchase_orders WHERE tenant_id=$1 AND status IN ('draft','sent','partial')`, [tenantId]),
    ]);

    return res.json({
      success: true,
      dashboard: {
        today: todaySales.rows[0],
        month: monthSales.rows[0],
        lowStock: lowStock.rows,
        pendingOrders: pendingOrders.rows[0],
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
