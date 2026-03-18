import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/database';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT id, email, first_name, last_name, role, status, avatar_url, last_login, created_at FROM users WHERE tenant_id = $1 ORDER BY first_name ASC`, [req.user!.tenantId]);
    return res.json({ success: true, users: result.rows });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, first_name, last_name, phone, role } = req.body;
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(`INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, phone, role, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id, email, first_name, last_name, role, status`, [req.user!.tenantId, email, passwordHash, first_name, last_name, phone, role]);
    return res.status(201).json({ success: true, user: result.rows[0] });
  } catch (error: any) { return res.status(500).json({ success: false, message: error.message }); }
});

router.patch('/:id/status', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    await query('UPDATE users SET status=$1 WHERE id=$2 AND tenant_id=$3', [status, req.params.id, req.user!.tenantId]);
    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.put('/:id/password', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.body;
    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2 AND tenant_id=$3', [hash, req.params.id, req.user!.tenantId]);
    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

export default router;
