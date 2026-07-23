# Database Troubleshooting Script
# Run this when you see "Project not found" or 404 errors in Database Management
# Usage: .\scripts\fix-database-errors.ps1

Write-Host "`n🔧 Database Error Fix - Production Grade`n" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan

# Step 1: Kill all Node processes
Write-Host "Step 1: Stopping all Node processes..." -ForegroundColor Yellow
try {
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "✅ Node processes stopped`n" -ForegroundColor Green
} catch {
    Write-Host "⚠️  No Node processes found (already stopped)`n" -ForegroundColor Yellow
}

# Step 2: Clear Next.js cache
Write-Host "Step 2: Clearing Next.js build cache..." -ForegroundColor Yellow
if (Test-Path .next) {
    Remove-Item -Recurse -Force .next
    Write-Host "✅ .next cache cleared`n" -ForegroundColor Green
} else {
    Write-Host "⚠️  No .next directory found`n" -ForegroundColor Yellow
}

# Step 3: Check database connection
Write-Host "Step 3: Checking database connection..." -ForegroundColor Yellow
try {
    npx prisma db execute --stdin -ErrorAction Stop <<< "SELECT 1;"
    Write-Host "✅ Database connection successful`n" -ForegroundColor Green
} catch {
    Write-Host "❌ Database connection failed!" -ForegroundColor Red
    Write-Host "   Please check your DATABASE_URL in .env`n" -ForegroundColor Red
}

# Step 4: Run health check
Write-Host "Step 4: Running database health check..." -ForegroundColor Yellow
try {
    npx tsx scripts/check-database-health.ts
    Write-Host ""
} catch {
    Write-Host "⚠️  Health check not available (script may be missing)`n" -ForegroundColor Yellow
}

# Step 5: Restart development server
Write-Host "Step 5: Restarting development server..." -ForegroundColor Yellow
Write-Host "   Starting server on http://localhost:3000`n" -ForegroundColor Cyan

Start-Process powershell -ArgumentList "-NoExit", "-Command", "npm run dev"

Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan
Write-Host "✅ Fix Complete!`n" -ForegroundColor Green
Write-Host "Next Steps:`n" -ForegroundColor Cyan
Write-Host "1. Wait 10 seconds for server to start" -ForegroundColor White
Write-Host "2. Refresh your browser (Ctrl+F5)" -ForegroundColor White
Write-Host "3. Navigate to Database Management page" -ForegroundColor White
Write-Host "4. If errors persist, check the console logs above`n" -ForegroundColor White

Write-Host "Common Solutions:`n" -ForegroundColor Cyan
Write-Host "• If 401/403 errors: Log out and log back in" -ForegroundColor White
Write-Host "• If 404 errors: Wait 30 seconds for full compilation" -ForegroundColor White
Write-Host "• If 'Project not found': Verify project exists in database`n" -ForegroundColor White
