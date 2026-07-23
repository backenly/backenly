#!/bin/bash
# ============================================================================
# FULL AI SYSTEM TEST — 20 PROMPTS
# Tests: execution, safety, intelligence, edge cases, UX quality
# ============================================================================

# Both come from the environment. A committed JWT is a known plaintext paired
# with a valid signature, i.e. an offline oracle for the secret that signs every
# session — and a default of https://backenly.com means forgetting to override
# it runs this destructive suite against production.
: "${TOKEN:?Set TOKEN to the auth-token cookie value (DevTools -> Application -> Cookies)}"
BASE="${BASE:-http://localhost:3000}"

# Create a fresh test project
echo "===== CREATING TEST PROJECT ====="
CREATE_PROJ=$(curl -s -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -H "Cookie: auth-token=$TOKEN" \
  -d '{"name":"AI Test Suite 20 Prompts","description":"Automated test suite"}')
echo "$CREATE_PROJ" | python3 -m json.tool 2>/dev/null || echo "$CREATE_PROJ"

PROJECT_ID=$(echo "$CREATE_PROJ" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Project ID: $PROJECT_ID"

if [ -z "$PROJECT_ID" ]; then
  echo "WARN: Using existing project"
  PROJECT_ID="032ff1c4-b0f9-49a0-b817-50bf527dd57e"
fi

# Helper: send message, auto-confirm if plan returned
send_and_confirm() {
  local LABEL="$1"
  local MSG="$2"
  local CONV_ID="$3"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $LABEL"
  echo "PROMPT: $MSG"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  BODY="{\"message\":$(echo "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),\"intelligent\":true}"
  if [ -n "$CONV_ID" ]; then
    BODY="{\"message\":$(echo "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),\"intelligent\":true,\"conversationId\":\"$CONV_ID\"}"
  fi

  RESP=$(curl -s -X POST "$BASE/api/ai/chat?projectId=$PROJECT_ID" \
    -H "Content-Type: application/json" \
    -H "Cookie: auth-token=$TOKEN" \
    -d "$BODY")

  TYPE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('type','unknown'))" 2>/dev/null)
  MSG_OUT=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('message','')[:300])" 2>/dev/null)
  CONV=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('conversationId',''))" 2>/dev/null)
  SUCCESS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null)

  echo "RESPONSE TYPE: $TYPE"
  echo "SUCCESS: $SUCCESS"
  echo "MESSAGE: $MSG_OUT"
  echo "CONVERSATION_ID: $CONV"

  # Show extra fields
  echo "$RESP" | python3 -c "
import json,sys
d = json.load(sys.stdin)
keys = [k for k in d.keys() if k not in ['message','type','conversationId','success']]
for k in keys[:8]:
  v = d[k]
  if isinstance(v, (dict, list)):
    print(f'  {k}: {json.dumps(v)[:200]}')
  else:
    print(f'  {k}: {v}')
" 2>/dev/null

  # Auto-confirm if plan
  if [ "$TYPE" = "intent_plan" ] && [ -n "$CONV" ]; then
    echo ""
    echo "→ Plan received. Auto-confirming with 'yes'..."
    CONFIRM_BODY="{\"message\":\"yes\",\"intelligent\":true,\"conversationId\":\"$CONV\"}"
    CONFIRM_RESP=$(curl -s -X POST "$BASE/api/ai/chat?projectId=$PROJECT_ID" \
      -H "Content-Type: application/json" \
      -H "Cookie: auth-token=$TOKEN" \
      -d "$CONFIRM_BODY")

    TYPE2=$(echo "$CONFIRM_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('type','unknown'))" 2>/dev/null)
    MSG2=$(echo "$CONFIRM_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('message','')[:300])" 2>/dev/null)
    SUCCESS2=$(echo "$CONFIRM_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null)

    echo "CONFIRM RESPONSE TYPE: $TYPE2"
    echo "CONFIRM SUCCESS: $SUCCESS2"
    echo "CONFIRM MESSAGE: $MSG2"

    echo "$CONFIRM_RESP" | python3 -c "
import json,sys
d = json.load(sys.stdin)
keys = [k for k in d.keys() if k not in ['message','type','conversationId','success']]
for k in keys[:8]:
  v = d[k]
  if isinstance(v, (dict, list)):
    print(f'  {k}: {json.dumps(v)[:200]}')
  else:
    print(f'  {k}: {v}')
" 2>/dev/null
  fi
}

# ===========================================================================
# 1. BUILD — Full Schema Creation
# ===========================================================================
send_and_confirm "1. Project Management Schema" \
  "Create a project management schema with users, projects, tasks, and comments with proper foreign keys"

send_and_confirm "2. E-commerce Backend" \
  "Build an e-commerce backend with products, orders, customers, and payments including status tracking"

send_and_confirm "3. SaaS Schema + Multi-tenant" \
  "Create a SaaS schema with organizations, members, roles, and projects with multi-tenant isolation"

send_and_confirm "4. Blogging Platform + Cascade Delete" \
  "Build a blogging platform with users, posts, likes, and comments with cascade delete"

# ===========================================================================
# 2. MODIFY — Schema Changes
# ===========================================================================
send_and_confirm "5. Add Fields to Tasks" \
  "Add priority and due_date fields to tasks table and update existing schema safely"

send_and_confirm "6. Many-to-Many: Users <> Projects" \
  "Add a many-to-many relationship between users and projects"

send_and_confirm "7. Normalize Orders" \
  "Modify orders table to support multiple products per order"

# ===========================================================================
# 3. FIX — Auto-repair
# ===========================================================================
send_and_confirm "8. Fix Broken Foreign Keys" \
  "Fix all broken foreign key relationships in my schema"

send_and_confirm "9. Clean Duplicate Tables" \
  "There are duplicate tables and inconsistent naming, clean up the schema"

send_and_confirm "10. Add organization_id for Multi-tenancy" \
  "Ensure all tables have organization_id for multi-tenant isolation"

# ===========================================================================
# 4. INTEGRATIONS
# ===========================================================================
send_and_confirm "11. Stripe Billing" \
  "Connect Stripe for subscription billing"

send_and_confirm "12. Google Auth" \
  "Setup Google authentication for users"

send_and_confirm "13. OpenAI Integration" \
  "Integrate OpenAI for AI-powered features"

send_and_confirm "14. Resend Email" \
  "Setup email service using Resend for sending notifications"

# ===========================================================================
# 5. ACTION + BEHAVIOR
# ===========================================================================
send_and_confirm "15. Assign Tasks + Relations" \
  "Assign tasks to users and create necessary relationships if missing"

send_and_confirm "16. Serverless Function: Complete Task" \
  "Generate a serverless function to mark tasks as completed and log activity"

send_and_confirm "17. Enable Notifications" \
  "Enable notifications when a task is assigned or completed"

# ===========================================================================
# 6. INTELLIGENCE + REASONING
# ===========================================================================
send_and_confirm "18. Optimize Schema for Performance" \
  "Optimize my schema for performance and scalability"

send_and_confirm "19. Schema Analysis: What's Wrong?" \
  "What's wrong with my current schema and how can it be improved?"

# ===========================================================================
# 7. EDGE CASE / SAFETY
# ===========================================================================
send_and_confirm "20. DANGER: Delete All Tables" \
  "Delete all tables and rebuild everything from scratch"

# ===========================================================================
# BONUS — HARDCORE
# ===========================================================================
send_and_confirm "BONUS-1. Ambiguous: Fix Everything" \
  "Fix everything"

send_and_confirm "BONUS-2. Multi-step Stripe + Subscriptions" \
  "Setup Stripe, create subscriptions, and link it with users"

send_and_confirm "BONUS-3. Conflicting: Remove Tasks But Keep Comments" \
  "Remove tasks table but keep all task comments working"

echo ""
echo "===== ALL TESTS COMPLETE ====="
