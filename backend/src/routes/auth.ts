import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router: Router = Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    let userResult = await query(
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status, t.logo_url as tenant_logo
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND u.role = 'superadmin'`,
      [email]
    );
    if (!userResult.rows.length) {
      userResult = await query(
        `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status, t.logo_url as tenant_logo
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = $1 AND u.role != 'superadmin'`,
        [email]
      );
    }
    if (!userResult.rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const user = userResult.rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }
    if (user.role !== 'superadmin' && user.tenant_status !== 'active') {
      return res.status(403).json({ success: false, message: 'Your account is not active. Contact support.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' }
    );
    return res.json({
      success: true, token, refreshToken,
      user: {
        id: user.id, email: user.email, firstName: user.first_name,
        lastName: user.last_name, role: user.role, tenantId: user.tenant_id,
        tenantName: user.tenant_name, tenantSlug: user.tenant_slug,
        tenantLogo: user.tenant_logo, avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.tenant_id,
              u.avatar_url, u.last_login, u.status, u.permissions,
              t.name as tenant_name, t.slug as tenant_slug, t.logo_url as tenant_logo, t.settings as tenant_settings
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.user!.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const u = result.rows[0];
    return res.json({
      success: true,
      user: {
        id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name,
        role: u.role, tenantId: u.tenant_id, tenantName: u.tenant_name,
        tenantSlug: u.tenant_slug, tenantLogo: u.tenant_logo,
        tenantSettings: u.tenant_settings, avatarUrl: u.avatar_url,
        lastLogin: u.last_login, permissions: u.permissions,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as any;
    const userResult = await query('SELECT id, email, role, tenant_id, status FROM users WHERE id = $1', [decoded.userId]);
    if (!userResult.rows.length || userResult.rows[0].status !== 'active') {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
    const user = userResult.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    return res.json({ success: true, token });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }
});

export default router;
