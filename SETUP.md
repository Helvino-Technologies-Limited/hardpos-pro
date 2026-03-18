# HARD-POS PRO Setup Guide

## Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)

## Quick Start

### 1. Install Dependencies
```bash
cd hardpos-pro/backend && pnpm install
cd ../frontend && pnpm install
```

### 2. Run Database Migrations
```bash
cd hardpos-pro/backend
pnpm db:migrate
pnpm db:seed
```

### 3. Start Development
```bash
cd hardpos-pro
bash start-dev.sh
```

## Deployment

### Backend → Render
1. Push `hardpos-pro/backend` to GitHub
2. Create new Web Service on Render
3. Set environment variables (DATABASE_URL, JWT_SECRET, etc.)
4. Deploy

### Frontend → Vercel  
1. Push `hardpos-pro/frontend` to GitHub
2. Import project on Vercel
3. Set `NEXT_PUBLIC_API_URL` to your Render backend URL
4. Deploy

## Default Credentials
- **SuperAdmin**: superadmin@helvinotech.com / HelvnoAdmin@2024!
- **Demo Store Admin**: admin@demo.co.ke / Admin@2024!

## Support
- Phone: 0110421320
- Email: helvinotechltd@gmail.com
