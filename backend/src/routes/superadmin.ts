import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/database';
import { authenticate, requireSuperAdmin, AuthRequest } from '../middleware/auth';

const router: Router = Router();
router.use(authenticate, requireSuperAdmin);

router.get('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIdx = 1;
    if (search) { whereClause += ` AND (t.name ILIKE $${paramIdx} OR t.email ILIKE $${paramIdx} OR t.slug ILIKE $${paramIdx})`; params.push(`%${search}%`); paramIdx++; }
    if (status) { whereClause += ` AND t.status = $${paramIdx}`; params.push(status); paramIdx++; }
    const countResult = await query(`SELECT COUNT(*) FROM tenants t ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);
    const result = await query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.role != 'superadmin') as user_count,
        (SELECT COUNT(*) FROM branches b WHERE b.tenant_id = t.id) as branch_count,
        (SELECT COUNT(*) FROM sales s WHERE s.tenant_id = t.id AND s.sale_date >= NOW() - INTERVAL '30 days') as sales_30d
      FROM tenants t ${whereClause}
      ORDER BY t.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, [...params, Number(limit), offset]);
    return res.json({ success: true, tenants: result.rows, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
  } catch (error) { console.error(error); return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, phone, address, city, plan, adminEmail, adminPassword, adminFirstName, adminLastName } = req.body;
    if (!name || !email || !adminEmail || !adminPassword) return res.status(400).json({ success: false, message: 'Missing required fields' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = await query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    const finalSlug = existing.rows.length ? `${slug}-${Date.now()}` : slug;
    const tenantResult = await query(`INSERT INTO tenants (name, slug, email, phone, address, city, plan, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`, [name, finalSlug, email, phone, address, city, plan || 'basic']);
    const tenant = tenantResult.rows[0];
    await query(`INSERT INTO branches (tenant_id, name, code, address, city, is_main, status) VALUES ($1,$2,'MAIN',$3,$4,true,'active')`, [tenant.id, `${name} - Main Branch`, address, city]);
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await query(`INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, status) VALUES ($1,$2,$3,$4,$5,'admin','active')`, [tenant.id, adminEmail, passwordHash, adminFirstName || 'Admin', adminLastName || name]);
    const cats = [['Building Materials','building-materials'],['Plumbing','plumbing'],['Electrical','electrical'],['Tools','tools'],['Hardware & Fasteners','hardware'],['Paint & Coatings','paint'],['Agricultural','agricultural'],['Kitchen & Bathroom','kitchen-bathroom']];
    for (const [catName, catSlug] of cats) {
      await query('INSERT INTO categories (tenant_id, name, slug) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [tenant.id, catName, catSlug]);
    }
    return res.status(201).json({ success: true, tenant, message: 'Tenant created successfully' });
  } catch (error: any) { console.error(error); return res.status(500).json({ success: false, message: error.message || 'Server error' }); }
});

router.patch('/tenants/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['active', 'inactive', 'suspended'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    const result = await query('UPDATE tenants SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [status, id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Tenant not found' });
    return res.json({ success: true, tenant: result.rows[0] });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.put('/tenants/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, phone, address, city, plan } = req.body;
    const result = await query(`UPDATE tenants SET name=$1,email=$2,phone=$3,address=$4,city=$5,plan=$6,updated_at=NOW() WHERE id=$7 RETURNING *`, [name, email, phone, address, city, plan, id]);
    return res.json({ success: true, tenant: result.rows[0] });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [tenantStats, userStats, salesStats] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active, COUNT(*) FILTER (WHERE status='inactive') as inactive, COUNT(*) FILTER (WHERE status='suspended') as suspended FROM tenants`),
      query(`SELECT COUNT(*) as total FROM users WHERE role != 'superadmin'`),
      query(`SELECT COUNT(*) as total_sales, COALESCE(SUM(total_amount),0) as total_revenue FROM sales WHERE sale_date >= NOW() - INTERVAL '30 days'`),
    ]);
    return res.json({ success: true, stats: { tenants: tenantStats.rows[0], users: userStats.rows[0], sales: salesStats.rows[0] } });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/tenants/:id/login-as', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const adminUser = await query(
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$1 AND u.role='admin' LIMIT 1`,
      [id]
    );
    if (!adminUser.rows.length) return res.status(404).json({ success: false, message: 'No admin found for this tenant' });
    const u = adminUser.rows[0];
    const token = jwt.sign(
      { userId: u.id, email: u.email, role: u.role, tenantId: u.tenant_id, impersonatedBy: req.user!.id },
      process.env.JWT_SECRET!,
      { expiresIn: '8h' }
    );
    return res.json({ success: true, token, user: { id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, role: u.role, tenant_id: u.tenant_id, tenantName: u.tenant_name, tenantSlug: u.tenant_slug } });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

export default router;
