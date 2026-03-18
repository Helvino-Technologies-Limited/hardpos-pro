import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT * FROM categories WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order, name', [req.user!.tenantId]);
    return res.json({ success: true, categories: result.rows });
  } catch (error) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, icon, color, parent_id } = req.body;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const result = await query('INSERT INTO categories (tenant_id, name, slug, description, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user!.tenantId, name, slug, description, icon, color, parent_id]);
    return res.status(201).json({ success: true, category: result.rows[0] });
  } catch (error: any) { return res.status(500).json({ success: false, message: error.message }); }
});

export default router;
