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
      `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
              t.logo_url as tenant_logo, t.trial_ends_at
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND u.role = 'superadmin'`,
      [email]
    );
    if (!userResult.rows.length) {
      userResult = await query(
        `SELECT u.*, t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
                t.logo_url as tenant_logo, t.trial_ends_at
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

    // Tenant status check for non-superadmin
    if (user.role !== 'superadmin') {
      if (user.tenant_status === 'trial') {
        // Check if trial has expired
        if (user.trial_ends_at && new Date(user.trial_ends_at) < new Date()) {
          await query('UPDATE tenants SET status = $1, updated_at = NOW() WHERE id = $2', ['inactive', user.tenant_id]);
          return res.status(403).json({
            success: false,
            message: 'Your 5-day free trial has expired. To subscribe, pay via Paybill 522533, Account 8071524. First year: KSH 50,000 | Annual renewal: KSH 20,000. Call 0110421320 for help.',
          });
        }
      } else if (user.tenant_status !== 'active') {
        return res.status(403).json({ success: false, message: 'Your account is not active. Contact support on 0110421320.' });
      }
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
        tenantStatus: user.tenant_status,
        trialEndsAt: user.trial_ends_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Public self-registration for new tenants (5-day trial)
router.post('/register', async (req: Request, res: Response) => {
  try {
    const {
      businessName, email, phone, city, address,
      adminEmail, adminPassword, adminFirstName, adminLastName,
    } = req.body;

    if (!businessName || !email || !adminEmail || !adminPassword || !adminFirstName) {
      return res.status(400).json({ success: false, message: 'Business name, email, admin email, password and first name are required' });
    }

    // Check if admin email already exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (existingUser.rows.length) {
      return res.status(409).json({ success: false, message: 'An account with this admin email already exists' });
    }

    // Generate slug
    const baseSlug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = await query('SELECT id FROM tenants WHERE slug = $1', [baseSlug]);
    const slug = existing.rows.length ? `${baseSlug}-${Date.now()}` : baseSlug;

    // Trial ends 5 days from now
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 5);

    // Create tenant
    const tenantResult = await query(
      `INSERT INTO tenants (name, slug, email, phone, address, city, plan, status, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'basic', 'trial', $7) RETURNING *`,
      [businessName, slug, email, phone || null, address || null, city || null, trialEndsAt.toISOString()]
    );
    const tenant = tenantResult.rows[0];

    // Create main branch
    await query(
      `INSERT INTO branches (tenant_id, name, code, address, city, is_main, status)
       VALUES ($1, $2, 'MAIN', $3, $4, true, 'active')`,
      [tenant.id, `${businessName} - Main Branch`, address || null, city || null]
    );

    // Create admin user
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const userResult = await query(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'admin', 'active') RETURNING *`,
      [tenant.id, adminEmail, passwordHash, adminFirstName, adminLastName || businessName]
    );
    const newUser = userResult.rows[0];

    // Create default categories
    const cats = [
      ['Building Materials', 'building-materials'],
      ['Plumbing', 'plumbing'],
      ['Electrical', 'electrical'],
      ['Tools', 'tools'],
      ['Hardware & Fasteners', 'hardware'],
      ['Paint & Coatings', 'paint'],
      ['Agricultural', 'agricultural'],
      ['Kitchen & Bathroom', 'kitchen-bathroom'],
    ];
    for (const [catName, catSlug] of cats) {
      await query(
        'INSERT INTO categories (tenant_id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [tenant.id, catName, catSlug]
      );
    }

    // Auto-login: issue tokens
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role, tenantId: newUser.tenant_id },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    const refreshToken = jwt.sign(
      { userId: newUser.id },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      success: true,
      message: 'Business registered! Your 5-day free trial starts now.',
      token,
      refreshToken,
      user: {
        id: newUser.id, email: newUser.email,
        firstName: newUser.first_name, lastName: newUser.last_name,
        role: newUser.role, tenantId: newUser.tenant_id,
        tenantName: tenant.name, tenantSlug: tenant.slug,
        tenantStatus: tenant.status,
        trialEndsAt: tenant.trial_ends_at,
      },
    });
  } catch (error: any) {
    console.error('Register error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.tenant_id,
              u.avatar_url, u.last_login, u.status, u.permissions,
              t.name as tenant_name, t.slug as tenant_slug, t.logo_url as tenant_logo,
              t.settings as tenant_settings, t.status as tenant_status, t.trial_ends_at
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
        tenantStatus: u.tenant_status,
        trialEndsAt: u.trial_ends_at,
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
