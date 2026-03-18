import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import dotenv from 'dotenv';
import logger from './config/logger';

dotenv.config();

import authRoutes from './routes/auth';
import superadminRoutes from './routes/superadmin';
import productRoutes from './routes/products';
import salesRoutes from './routes/sales';
import customerRoutes from './routes/customers';
import inventoryRoutes from './routes/inventory';
import categoryRoutes from './routes/categories';
import userRoutes from './routes/users';
import reportRoutes from './routes/reports';
import branchRoutes from './routes/branches';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression() as any);
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000', 'https://*.vercel.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use('/api/', limiter);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/login', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

app.get('/health', (_, res) => res.json({ status: 'OK', service: 'HARD-POS PRO API', version: '1.0.0', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/products', productRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/branches', branchRoutes);

app.use('*', (req, res) => res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` }));
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`🚀 HARD-POS PRO API running on port ${PORT}`);
  logger.info(`📦 Environment: ${process.env.NODE_ENV}`);
});

export default app;
