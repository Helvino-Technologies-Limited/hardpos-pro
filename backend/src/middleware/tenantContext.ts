import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

export const tenantContext = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'superadmin') return next();
  
  if (!req.user?.tenantId) {
    return res.status(403).json({ success: false, message: 'No tenant context' });
  }

  const tenant = await query(
    'SELECT id, status FROM tenants WHERE id = $1',
    [req.user.tenantId]
  );

  if (!tenant.rows.length || tenant.rows[0].status !== 'active') {
    return res.status(403).json({ success: false, message: 'Tenant not active' });
  }

  next();
};
