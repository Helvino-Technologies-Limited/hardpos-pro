#!/bin/bash
echo "🚀 Starting HARD-POS PRO Development Environment"
echo ""

# Start backend
echo "📦 Starting Backend API (port 5000)..."
cd backend && pnpm dev &
BACKEND_PID=$!

# Wait for backend
sleep 3

# Start frontend
echo "🎨 Starting Frontend (port 3000)..."
cd ../frontend && pnpm dev &
FRONTEND_PID=$!

echo ""
echo "✅ HARD-POS PRO is running!"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:5000"
echo "   Health:   http://localhost:5000/health"
echo ""
echo "🔑 SuperAdmin: superadmin@helvinotech.com / HelvnoAdmin@2024!"
echo "🔑 Demo Admin: admin@demo.co.ke / Admin@2024!"
echo ""
echo "Press Ctrl+C to stop all services"

wait $BACKEND_PID $FRONTEND_PID
