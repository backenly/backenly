# AI Evaluation Harness

Tests 280 prompts against Backenly AI and generates comprehensive reports.

## Two Test Suites

### 1. Core Test Suite (114 prompts)
Tests all 8 backend sections with well-formed prompts:
- Database (CREATE_TABLE, ADD_COLUMN, INSERT_DATA)
- API Builder (GENERATE_API)
- Authentication (ENABLE_AUTH, BLOCK_USER)
- Storage (CREATE_BUCKET, UPLOAD_FILE)
- Deploy (TRIGGER_DEPLOY, SET_ENV_VAR)
- Monitoring (VIEW_LOGS, TRACK_METRIC)
- API Keys (CREATE_API_KEY)
- Connect (SETUP_OAUTH)

**Run:** `npm run evals`

### 2. Stress Test Suite (30 prompts)
Tests with intentionally tricky, ambiguous, incomplete requests:
- Schema + API dependency hell (orders referencing users, many-to-many)
- Ambiguous human requests ("make APIs faster", "track stock")
- Operations that break weak systems (rename columns, bulk deletes)

**Run:** `npm run stress-test`

**What These Tests Expose:**
These 30 prompts are designed to break weak AI systems. They test:

1. **Dependency Hell** - "Create orders API but users must already exist"
   - Tests: Auto-creation of referenced tables, foreign key inference
   - Expected behavior: AI creates users table first, then orders with FK

2. **Ambiguous Inference** - "Store when users last logged in"
   - Tests: Schema change inference from natural language
   - Expected behavior: AI adds last_login_at timestamp column to users

3. **Schema Operations** - "Rename price to unit_price in products"
   - Tests: Idempotent schema alterations, non-destructive changes
   - Expected behavior: RENAME_COLUMN action with rollback safety

4. **Bulk Operations** - "Delete all orders older than 60 days"
   - Tests: Complex WHERE clauses, data manipulation at scale
   - Expected behavior: DELETE with timestamp filter

5. **Context Awareness** - "Generate APIs for whatever tables exist"
   - Tests: Project state introspection, dynamic resource discovery
   - Expected behavior: Query all tables, generate API for each

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Get your auth token:**
   - Open browser
   - Go to Backenly (localhost:3000)
   - Login
   - Open DevTools (F12) → Application → Cookies
   - Copy the `auth-token` value

3. **Export it for the run — never edit it into the script.**

   A session cookie committed to a file is a known plaintext paired with a valid
   signature, which makes it an offline oracle for `JWT_SECRET` — the key that
   signs *every* session, not just yours. Expiry does not help; the signature
   stays verifiable. So it goes in the environment and nowhere else.

## Run Evaluation

```bash
AUTH_COOKIE='auth-token=<value>' PROJECT_ID=<uuid> npm run evals
```

`BASE_URL` defaults to `http://localhost:3000`. Set it only if you mean to run
against something else.

This will:
- Test all 280 prompts (takes ~5-10 minutes)
- Generate 4 report files in `evals/results/`

## Output Files

1. **`report-{timestamp}.json`** - Executive summary
   ```json
   {
     "total": 280,
     "passed": 45,
     "failed": 235,
     "passRate": "16.1%",
     "byCategory": {
       "DATABASE": { "passed": 12, "failed": 3 },
       "AUTHENTICATION": { "passed": 0, "failed": 40 }
     }
   }
   ```

2. **`errors-analysis-{timestamp}.json`** - Detailed error breakdown
   ```json
   [
     {
       "error_id": "AUTH_001",
       "prompt": "Enable Google OAuth",
       "root_cause": "OAuth features not implemented",
       "solution_needed": {
         "priority": "HIGH",
         "effort": "1 week",
         "implementation": "Build OAuth system..."
       }
     }
   ]
   ```

3. **`full-results-{timestamp}.json`** - Complete test results with all responses

4. **`recommendations-{timestamp}.md`** - Human-readable roadmap for tech team

## Understanding Results

**PASS** ✅ - AI understood and executed successfully
- Example: "Create users table" → Table created

**PARTIAL** ⚠️ - AI understood but execution failed
- Example: "Add Google OAuth" → AI knows what to do but feature doesn't exist

**FAIL** ❌ - AI didn't understand
- Example: "Deploy to custom domain" → AI says "I don't know how"

## Share with Tech Expert

Send these 2 files:
1. `errors-analysis-{timestamp}.json` - Shows what to build
2. `recommendations-{timestamp}.md` - Prioritized roadmap

## Example Output

```
🚀 Starting AI Evaluation Harness...

📊 Total prompts to test: 280

[1/280] Testing: Create a REST API for products with CRUD operations...
[2/280] Testing: Generate an API for user profiles with email validat...
...
[280/280] Testing: Test CORS configuration...

📝 Generating reports...

✅ Reports generated successfully!

📊 RESULTS:
   Total: 280
   Passed: 45 (16.1%)
   Failed: 235
   Partial: 0

📁 Files created in evals/results/
   - report-2026-01-10T23-45-00.json
   - errors-analysis-2026-01-10T23-45-00.json
   - full-results-2026-01-10T23-45-00.json
   - recommendations-2026-01-10T23-45-00.md
```

## What Happens Next

1. **Review `recommendations.md`** - See what to build next
2. **Implement high-priority fixes** - Focus on highest-impact features
3. **Re-run evals** - Track improvement over time
4. **Target: 70%+ pass rate** - Goal for production readiness

## Tips

- Run evals after major changes to track progress
- Compare reports over time to see improvement
- Use error analysis to prioritize development
- Share reports with stakeholders for data-driven decisions
