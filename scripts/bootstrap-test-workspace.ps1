# =============================================================================
# Backenly API Tester - Bootstrap Test Workspace Script (PowerShell)
# =============================================================================
#
# This script:
# 1. Creates a test workspace with sample routes
# 2. Runs smoke tests using Invoke-RestMethod
#
# Usage: .\scripts\bootstrap-test-workspace.ps1
# =============================================================================

param(
    [string]$ProjectId = "test-project",
    [string]$WorkspaceRoot = "./workspace",
    [int]$WorkerPort = 5173
)

$WorkerUrl = "http://localhost:$WorkerPort"

# =============================================================================
# Helper Functions
# =============================================================================

function Write-Info($message) {
    Write-Host "[INFO] $message" -ForegroundColor Cyan
}

function Write-Success($message) {
    Write-Host "[SUCCESS] $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "[WARN] $message" -ForegroundColor Yellow
}

function Write-Error($message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
}

function Write-Separator {
    Write-Host "============================================================"
}

# =============================================================================
# Create Test Workspace
# =============================================================================

function New-TestWorkspace {
    Write-Separator
    Write-Info "Creating test workspace at $WorkspaceRoot/$ProjectId"
    Write-Separator

    $projectPath = Join-Path $WorkspaceRoot $ProjectId

    # Create directories
    $dirs = @(
        "api/ping",
        "api/hello",
        "api/todos/[id]",
        "api/echo",
        "api/files/[...slug]",
        "lib"
    )

    foreach ($dir in $dirs) {
        $fullPath = Join-Path $projectPath $dir
        New-Item -ItemType Directory -Force -Path $fullPath | Out-Null
    }

    # Create shared library
    @'
// Shared utilities module
export function formatResponse(data: any) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    data,
  };
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
'@ | Set-Content -Path (Join-Path $projectPath "lib/utils.ts") -Encoding UTF8

    # Create ping route (CommonJS JavaScript)
    @'
// CommonJS ping route
module.exports = {
  GET: async function(req) {
    return Response.json({
      pong: true,
      timestamp: new Date().toISOString(),
      type: 'commonjs',
    });
  },
};
'@ | Set-Content -Path (Join-Path $projectPath "api/ping/route.js") -Encoding UTF8

    # Create hello route (TypeScript)
    @'
// TypeScript hello route

interface HelloResponse {
  message: string;
  name: string;
  type: string;
}

export async function GET(req: any): Promise<Response> {
  const name = req.searchParams.get('name') || 'World';
  
  const response: HelloResponse = {
    message: `Hello, ${name}!`,
    name,
    type: 'typescript',
  };
  
  return Response.json(response);
}

export async function POST(req: any): Promise<Response> {
  const body = await req.json();
  
  return Response.json({
    message: `Hello, ${body.name || 'Anonymous'}!`,
    received: body,
    type: 'typescript',
  });
}
'@ | Set-Content -Path (Join-Path $projectPath "api/hello/route.ts") -Encoding UTF8

    # Create todos/[id] route
    $todosRoute = @"
// Dynamic route with [id] parameter

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

// Mock database
const todos: Record<string, Todo> = {
  '1': { id: '1', title: 'Learn TypeScript', completed: true },
  '2': { id: '2', title: 'Build API Worker', completed: false },
  '3': { id: '3', title: 'Write Tests', completed: false },
};

export async function GET(req: any): Promise<Response> {
  const { id } = req.params;
  
  const todo = todos[id];
  
  if (!todo) {
    return Response.json(
      { error: 'Todo not found', id },
      { status: 404 }
    );
  }
  
  return Response.json({
    todo,
    params: req.params,
  });
}

export async function PUT(req: any): Promise<Response> {
  const { id } = req.params;
  const body = await req.json();
  
  if (!todos[id]) {
    return Response.json(
      { error: 'Todo not found', id },
      { status: 404 }
    );
  }
  
  todos[id] = { ...todos[id], ...body };
  
  return Response.json({
    updated: true,
    todo: todos[id],
  });
}

export async function DELETE(req: any): Promise<Response> {
  const { id } = req.params;
  
  if (!todos[id]) {
    return Response.json(
      { error: 'Todo not found', id },
      { status: 404 }
    );
  }
  
  const deleted = todos[id];
  delete todos[id];
  
  return Response.json({
    deleted: true,
    todo: deleted,
  });
}
"@
    [System.IO.File]::WriteAllText((Join-Path $projectPath "api/todos/[id]/route.ts"), $todosRoute)

    # Create echo route
    @'
// Echo route - returns request information

export async function GET(req: any): Promise<Response> {
  return Response.json({
    method: req.method,
    url: req.url,
    headers: req.headers,
    params: req.params,
    searchParams: Object.fromEntries(req.searchParams.entries()),
  });
}

export async function POST(req: any): Promise<Response> {
  const body = await req.json();
  
  return Response.json({
    method: req.method,
    body,
    headers: req.headers,
  });
}
'@ | Set-Content -Path (Join-Path $projectPath "api/echo/route.ts") -Encoding UTF8

    # Create catch-all route
    $catchAllRoute = @"
// Catch-all route with [...slug] parameter

export async function GET(req: any): Promise<Response> {
  const { slug } = req.params;
  
  return Response.json({
    path: Array.isArray(slug) ? slug.join('/') : slug,
    segments: slug,
    segmentCount: Array.isArray(slug) ? slug.length : 1,
    params: req.params,
  });
}
"@
    [System.IO.File]::WriteAllText((Join-Path $projectPath "api/files/[...slug]/route.ts"), $catchAllRoute)

    Write-Success "Test workspace created!"
    Write-Host ""
    Write-Info "Routes created:"
    Write-Host "  - GET  /api/ping          (CommonJS)"
    Write-Host "  - GET  /api/hello         (TypeScript)"
    Write-Host "  - POST /api/hello         (TypeScript)"
    Write-Host "  - GET  /api/todos/:id     (Dynamic segment)"
    Write-Host "  - PUT  /api/todos/:id     (Dynamic segment)"
    Write-Host "  - DELETE /api/todos/:id   (Dynamic segment)"
    Write-Host "  - GET  /api/echo          (Request echo)"
    Write-Host "  - POST /api/echo          (Request echo)"
    Write-Host "  - GET  /api/files/*       (Catch-all)"
    Write-Host ""
}

# =============================================================================
# Run Smoke Tests
# =============================================================================

$script:testCount = 0
$script:passCount = 0
$script:failCount = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Url,
        [int]$ExpectedStatus,
        [string]$ExpectedContains = "",
        [object]$Body = $null,
        [hashtable]$Headers = @{}
    )

    $script:testCount++
    Write-Host "  Testing: $Name... " -NoNewline

    try {
        $params = @{
            Uri = $Url
            Method = $Method
            ContentType = "application/json"
            ErrorAction = "Stop"
        }

        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json)
        }

        if ($Headers.Count -gt 0) {
            $params.Headers = $Headers
        }

        $response = Invoke-WebRequest @params -UseBasicParsing
        $statusCode = $response.StatusCode
        $content = $response.Content
    }
    catch {
        if ($_.Exception.Response) {
            $statusCode = $_.Exception.Response.StatusCode.value__
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $content = $reader.ReadToEnd()
            $reader.Close()
        }
        else {
            Write-Host "FAIL" -ForegroundColor Red -NoNewline
            Write-Host " (Connection error: $($_.Exception.Message))"
            $script:failCount++
            return
        }
    }

    if ($statusCode -ne $ExpectedStatus) {
        Write-Host "FAIL" -ForegroundColor Red -NoNewline
        Write-Host " (expected status $ExpectedStatus, got $statusCode)"
        Write-Error "Response: $content"
        $script:failCount++
        return
    }

    if ($ExpectedContains -and $content -notlike "*$ExpectedContains*") {
        Write-Host "FAIL" -ForegroundColor Red -NoNewline
        Write-Host " (response doesn't contain '$ExpectedContains')"
        Write-Error "Response: $content"
        $script:failCount++
        return
    }

    Write-Host "PASS" -ForegroundColor Green
    $script:passCount++
}

function Invoke-SmokeTests {
    Write-Separator
    Write-Info "Running smoke tests against $WorkerUrl"
    Write-Separator
    Write-Host ""

    # Wait for worker to be ready
    Write-Info "Waiting for worker to be ready..."
    $retries = 30
    while ($retries -gt 0) {
        try {
            $null = Invoke-RestMethod -Uri "$WorkerUrl/health" -TimeoutSec 2 -ErrorAction Stop
            break
        }
        catch {
            $retries--
            if ($retries -le 0) {
                Write-Error "Worker did not start in time"
                exit 1
            }
            Write-Host "." -NoNewline
            Start-Sleep -Seconds 1
        }
    }
    Write-Host ""
    Write-Success "Worker is ready!"
    Write-Host ""

    # Health check
    Write-Info "Health Check Tests:"
    Test-Endpoint -Name "Health endpoint" -Method "GET" -Url "$WorkerUrl/health" -ExpectedStatus 200 -ExpectedContains '"status":"ok"'
    Write-Host ""

    # Ping route (CommonJS)
    Write-Info "CommonJS Route Tests:"
    Test-Endpoint -Name "Ping route (GET)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/ping" -ExpectedStatus 200 -ExpectedContains '"pong":true'
    Write-Host ""

    # Hello route (TypeScript)
    Write-Info "TypeScript Route Tests:"
    Test-Endpoint -Name "Hello route (GET)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/hello" -ExpectedStatus 200 -ExpectedContains '"message":"Hello, World!"'
    Test-Endpoint -Name "Hello route with param" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/hello?name=Test" -ExpectedStatus 200 -ExpectedContains '"name":"Test"'
    Test-Endpoint -Name "Hello route (POST)" -Method "POST" -Url "$WorkerUrl/workspace/$ProjectId/api/hello" -ExpectedStatus 200 -ExpectedContains '"type":"typescript"' -Body @{name="John"}
    Write-Host ""

    # Dynamic segment route
    Write-Info "Dynamic Segment Tests:"
    Test-Endpoint -Name "Todos route (GET /1)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/todos/1" -ExpectedStatus 200 -ExpectedContains '"id":"1"'
    Test-Endpoint -Name "Todos route (GET /2)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/todos/2" -ExpectedStatus 200 -ExpectedContains '"completed":false'
    Test-Endpoint -Name "Todos route (GET /999)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/todos/999" -ExpectedStatus 404 -ExpectedContains '"error":"Todo not found"'
    Test-Endpoint -Name "Todos route (PUT /1)" -Method "PUT" -Url "$WorkerUrl/workspace/$ProjectId/api/todos/1" -ExpectedStatus 200 -ExpectedContains '"updated":true' -Body @{completed=$true}
    Write-Host ""

    # Echo route
    Write-Info "Echo Route Tests:"
    Test-Endpoint -Name "Echo route (GET)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/echo" -ExpectedStatus 200 -ExpectedContains '"method":"GET"'
    Test-Endpoint -Name "Echo route (POST)" -Method "POST" -Url "$WorkerUrl/workspace/$ProjectId/api/echo" -ExpectedStatus 200 -ExpectedContains '"method":"POST"' -Body @{test="data"}
    Write-Host ""

    # Catch-all route
    Write-Info "Catch-all Route Tests:"
    Test-Endpoint -Name "Files route (single)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/files/readme.md" -ExpectedStatus 200 -ExpectedContains '"segmentCount"'
    Test-Endpoint -Name "Files route (nested)" -Method "GET" -Url "$WorkerUrl/workspace/$ProjectId/api/files/docs/api/intro" -ExpectedStatus 200 -ExpectedContains '"path":"docs/api/intro"'
    Write-Host ""

    # Summary
    Write-Separator
    Write-Host ""
    Write-Info "Test Summary:"
    Write-Host "  Total:  $script:testCount"
    Write-Host "  Passed: $script:passCount" -ForegroundColor Green
    if ($script:failCount -gt 0) {
        Write-Host "  Failed: $script:failCount" -ForegroundColor Red
    } else {
        Write-Host "  Failed: $script:failCount"
    }
    Write-Host ""

    if ($script:failCount -gt 0) {
        Write-Error "Some tests failed!"
        return $false
    } else {
        Write-Success "All tests passed!"
        return $true
    }
}

# =============================================================================
# Main
# =============================================================================

Write-Host ""
Write-Separator
Write-Host "  Backenly API Tester - Bootstrap Script"
Write-Separator
Write-Host ""

# Create test workspace
New-TestWorkspace

# Check if worker is already running
try {
    $null = Invoke-RestMethod -Uri "$WorkerUrl/health" -TimeoutSec 2 -ErrorAction Stop
    Write-Info "Worker is already running at $WorkerUrl"
}
catch {
    Write-Warn "Worker is not running. Please start it first:"
    Write-Host ""
    Write-Host "  cd worker; npm run dev"
    Write-Host ""
    Write-Info "Then run this script again to execute tests"
    Write-Host ""
    exit 0
}

# Run smoke tests
$success = Invoke-SmokeTests

Write-Host ""
Write-Separator
Write-Host ""

if (-not $success) {
    exit 1
}

