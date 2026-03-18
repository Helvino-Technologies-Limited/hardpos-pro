import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT * FROM branches WHERE tenant_id=$1 ORDER BY is_main DESC, name ASC', [req.user!.tenantId]);
    return res.json({ success: true, branches: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, code, address, city, phone, email } = req.body;
    const result = await query(
      `INSERT INTO branches (tenant_id, name, code, address, city, phone, email, is_main, status) VALUES ($1,$2,$3,$4,$5,$6,$7,false,'active') RETURNING *`,
      [req.user!.tenantId, name, code, address, city, phone, email]
    );
    return res.status(201).json({ success: true, branch: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
