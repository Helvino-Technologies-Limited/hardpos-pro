import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, requireManager, AuthRequest } from '../middleware/auth';
import { tenantContext } from '../middleware/tenantContext';

const router: Router = Router();
router.use(authenticate, tenantContext);

// GET /api/settings/receipt
router.get('/receipt', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(
      'SELECT name, email, phone, address, city, settings FROM tenants WHERE id = $1',
      [tenantId]
    );
    const tenant = result.rows[0];
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const saved = (tenant.settings?.receipt) || {};
    const defaults = {
      businessName: tenant.name,
      tagline: '',
      address: [tenant.address, tenant.city].filter(Boolean).join(', '),
      phone1: tenant.phone || '',
      phone2: '',
      email: tenant.email || '',
      kraPin: '',
      website: '',
      footerMessage: 'Thank you for your business!',
      showVat: true,
      showKraPin: false,
      showCashier: true,
      showSaleNumber: true,
      paperWidth: '80',
    };

    return res.json({ success: true, receipt: { ...defaults, ...saved } });
  } catch (error: any) {
    console.error('GET receipt settings error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/settings/receipt
router.put('/receipt', requireManager, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    await query(
      `UPDATE tenants
       SET settings = jsonb_set(COALESCE(settings, '{}'), '{receipt}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(req.body), tenantId]
    );
    return res.json({ success: true, message: 'Receipt settings saved' });
  } catch (error: any) {
    console.error('PUT receipt settings error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
