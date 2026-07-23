#!/bin/bash

# =============================================================================
# Backenly API Tester - Bootstrap Test Workspace Script
# =============================================================================
#
# This script:
# 1. Creates a test workspace with sample routes
# 2. Starts the worker
# 3. Runs smoke tests using curl
#
# Usage: ./scripts/bootstrap-test-workspace.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="test-project"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-./workspace}"
WORKER_PORT="${WORKER_PORT:-5173}"
WORKER_URL="http://localhost:${WORKER_PORT}"

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

separator() {
    echo "============================================================"
}

# =============================================================================
# Create Test Workspace
# =============================================================================

create_test_workspace() {
    separator
    log_info "Creating test workspace at ${WORKSPACE_ROOT}/${PROJECT_ID}"
    separator

    # Create directories
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/api/ping"
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/api/hello"
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/api/todos/[id]"
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/api/echo"
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/api/files/[...slug]"
    mkdir -p "${WORKSPACE_ROOT}/${PROJECT_ID}/lib"

    # Create shared library (for testing @/ imports)
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/lib/utils.ts" << 'EOF'
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
EOF

    # Create ping route (CommonJS JavaScript)
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/api/ping/route.js" << 'EOF'
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
EOF

    # Create hello route (TypeScript)
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/api/hello/route.ts" << 'EOF'
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
EOF

    # Create todos/[id] route (Dynamic segment - TypeScript)
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/api/todos/[id]/route.ts" << 'EOF'
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
EOF

    # Create echo route (for testing request data)
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/api/echo/route.ts" << 'EOF'
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
EOF

    # Create catch-all route for files
    cat > "${WORKSPACE_ROOT}/${PROJECT_ID}/api/files/[...slug]/route.ts" << 'EOF'
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
EOF

    log_success "Test workspace created!"
    echo ""
    log_info "Routes created:"
    echo "  - GET  /api/ping          (CommonJS)"
    echo "  - GET  /api/hello         (TypeScript)"
    echo "  - POST /api/hello         (TypeScript)"
    echo "  - GET  /api/todos/:id     (Dynamic segment)"
    echo "  - PUT  /api/todos/:id     (Dynamic segment)"
    echo "  - DELETE /api/todos/:id   (Dynamic segment)"
    echo "  - GET  /api/echo          (Request echo)"
    echo "  - POST /api/echo          (Request echo)"
    echo "  - GET  /api/files/*       (Catch-all)"
    echo ""
}

# =============================================================================
# Run Smoke Tests
# =============================================================================

test_count=0
pass_count=0
fail_count=0

run_test() {
    local name="$1"
    local method="$2"
    local url="$3"
    local expected_status="$4"
    local expected_contains="$5"
    local body="$6"
    
    test_count=$((test_count + 1))
    
    echo -n "  Testing: ${name}... "
    
    local curl_args=("-s" "-w" "\n%{http_code}" "-X" "${method}")
    
    if [ -n "$body" ]; then
        curl_args+=("-H" "Content-Type: application/json" "-d" "${body}")
    fi
    
    local response
    response=$(curl "${curl_args[@]}" "${url}" 2>/dev/null)
    
    local status_code
    status_code=$(echo "$response" | tail -1)
    local body_content
    body_content=$(echo "$response" | sed '$d')
    
    if [ "$status_code" != "$expected_status" ]; then
        echo -e "${RED}FAIL${NC} (expected status ${expected_status}, got ${status_code})"
        log_error "Response: ${body_content}"
        fail_count=$((fail_count + 1))
        return 1
    fi
    
    if [ -n "$expected_contains" ]; then
        if echo "$body_content" | grep -q "$expected_contains"; then
            echo -e "${GREEN}PASS${NC}"
            pass_count=$((pass_count + 1))
        else
            echo -e "${RED}FAIL${NC} (response doesn't contain '${expected_contains}')"
            log_error "Response: ${body_content}"
            fail_count=$((fail_count + 1))
            return 1
        fi
    else
        echo -e "${GREEN}PASS${NC}"
        pass_count=$((pass_count + 1))
    fi
}

run_smoke_tests() {
    separator
    log_info "Running smoke tests against ${WORKER_URL}"
    separator
    echo ""
    
    # Wait for worker to be ready
    log_info "Waiting for worker to be ready..."
    local retries=30
    while ! curl -s "${WORKER_URL}/health" > /dev/null 2>&1; do
        retries=$((retries - 1))
        if [ $retries -le 0 ]; then
            log_error "Worker did not start in time"
            exit 1
        fi
        sleep 1
        echo -n "."
    done
    echo ""
    log_success "Worker is ready!"
    echo ""
    
    # Health check
    log_info "Health Check Tests:"
    run_test "Health endpoint" "GET" "${WORKER_URL}/health" "200" '"status":"ok"'
    echo ""
    
    # Ping route (CommonJS)
    log_info "CommonJS Route Tests:"
    run_test "Ping route (GET)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/ping" "200" '"pong":true'
    echo ""
    
    # Hello route (TypeScript)
    log_info "TypeScript Route Tests:"
    run_test "Hello route (GET)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/hello" "200" '"message":"Hello, World!"'
    run_test "Hello route with param" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/hello?name=Test" "200" '"name":"Test"'
    run_test "Hello route (POST)" "POST" "${WORKER_URL}/workspace/${PROJECT_ID}/api/hello" "200" '"type":"typescript"' '{"name":"John"}'
    echo ""
    
    # Dynamic segment route
    log_info "Dynamic Segment Tests:"
    run_test "Todos route (GET /1)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/todos/1" "200" '"id":"1"'
    run_test "Todos route (GET /2)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/todos/2" "200" '"completed":false'
    run_test "Todos route (GET /999)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/todos/999" "404" '"error":"Todo not found"'
    run_test "Todos route (PUT /1)" "PUT" "${WORKER_URL}/workspace/${PROJECT_ID}/api/todos/1" "200" '"updated":true' '{"completed":true}'
    echo ""
    
    # Echo route
    log_info "Echo Route Tests:"
    run_test "Echo route (GET)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/echo" "200" '"method":"GET"'
    run_test "Echo route (POST)" "POST" "${WORKER_URL}/workspace/${PROJECT_ID}/api/echo" "200" '"method":"POST"' '{"test":"data"}'
    echo ""
    
    # Catch-all route
    log_info "Catch-all Route Tests:"
    run_test "Files route (single)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/files/readme.md" "200" '"segmentCount"'
    run_test "Files route (nested)" "GET" "${WORKER_URL}/workspace/${PROJECT_ID}/api/files/docs/api/intro" "200" '"path":"docs/api/intro"'
    echo ""
    
    # Using x-project-id header
    log_info "Header Project ID Tests:"
    run_test "With x-project-id header" "GET" "${WORKER_URL}/api/ping" "200" '"pong":true' '' "-H x-project-id:${PROJECT_ID}"
    echo ""
    
    # Summary
    separator
    echo ""
    log_info "Test Summary:"
    echo "  Total:  ${test_count}"
    echo -e "  ${GREEN}Passed: ${pass_count}${NC}"
    if [ $fail_count -gt 0 ]; then
        echo -e "  ${RED}Failed: ${fail_count}${NC}"
    else
        echo "  Failed: ${fail_count}"
    fi
    echo ""
    
    if [ $fail_count -gt 0 ]; then
        log_error "Some tests failed!"
        return 1
    else
        log_success "All tests passed!"
        return 0
    fi
}

# Override run_test for header support
run_test() {
    local name="$1"
    local method="$2"
    local url="$3"
    local expected_status="$4"
    local expected_contains="$5"
    local body="$6"
    local extra_header="$7"
    
    test_count=$((test_count + 1))
    
    echo -n "  Testing: ${name}... "
    
    local curl_args=("-s" "-w" "\n%{http_code}" "-X" "${method}")
    
    if [ -n "$body" ]; then
        curl_args+=("-H" "Content-Type: application/json" "-d" "${body}")
    fi
    
    if [ -n "$extra_header" ]; then
        curl_args+=("-H" "${extra_header}")
    fi
    
    local response
    response=$(curl "${curl_args[@]}" "${url}" 2>/dev/null)
    
    local status_code
    status_code=$(echo "$response" | tail -1)
    local body_content
    body_content=$(echo "$response" | sed '$d')
    
    if [ "$status_code" != "$expected_status" ]; then
        echo -e "${RED}FAIL${NC} (expected status ${expected_status}, got ${status_code})"
        log_error "Response: ${body_content}"
        fail_count=$((fail_count + 1))
        return 1
    fi
    
    if [ -n "$expected_contains" ]; then
        if echo "$body_content" | grep -q "$expected_contains"; then
            echo -e "${GREEN}PASS${NC}"
            pass_count=$((pass_count + 1))
        else
            echo -e "${RED}FAIL${NC} (response doesn't contain '${expected_contains}')"
            log_error "Response: ${body_content}"
            fail_count=$((fail_count + 1))
            return 1
        fi
    else
        echo -e "${GREEN}PASS${NC}"
        pass_count=$((pass_count + 1))
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    separator
    echo "  Backenly API Tester - Bootstrap Script"
    separator
    echo ""
    
    # Check for curl
    if ! command -v curl &> /dev/null; then
        log_error "curl is required but not installed"
        exit 1
    fi
    
    # Create test workspace
    create_test_workspace
    
    # Check if worker is already running
    if curl -s "${WORKER_URL}/health" > /dev/null 2>&1; then
        log_info "Worker is already running at ${WORKER_URL}"
    else
        log_warn "Worker is not running. Please start it first:"
        echo ""
        echo "  cd worker && npm run dev"
        echo ""
        log_info "Then run this script again to execute tests"
        echo ""
        exit 0
    fi
    
    # Run smoke tests
    run_smoke_tests
    
    exit_code=$?
    echo ""
    separator
    echo ""
    
    exit $exit_code
}

main "$@"

