import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

export const tenantContext = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'superadmin') return next();

  if (!req.user?.tenantId) {
    return res.status(403).json({ success: false, message: 'No tenant context' });
  }

  const tenant = await query(
    'SELECT id, status, trial_ends_at FROM tenants WHERE id = $1',
    [req.user.tenantId]
  );

  if (!tenant.rows.length) {
    return res.status(403).json({ success: false, message: 'Tenant not found' });
  }

  const t = tenant.rows[0];

  if (t.status === 'trial') {
    if (t.trial_ends_at && new Date(t.trial_ends_at) < new Date()) {
      // Auto-expire the trial
      await query('UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2', ['inactive', t.id]);
      return res.status(403).json({
        success: false,
        message: 'Your 5-day free trial has expired. Subscribe via Paybill 522533, Account 8071524. First year: KSH 50,000 | Annual: KSH 20,000.',
      });
    }
    return next(); // Trial is still active
  }

  if (t.status !== 'active') {
    return res.status(403).json({ success: false, message: 'Tenant not active. Contact support on 0110421320.' });
  }

  next();
};
