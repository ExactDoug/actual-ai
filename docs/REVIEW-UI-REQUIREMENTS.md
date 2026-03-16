# actual-ai Review UI Requirements

## Overview

A web-based review UI for actual-ai that allows users to observe, review, and
approve/reject AI-generated transaction classifications before they are written
to Actual Budget. The UI runs as part of the same container and uses the same
authentication as Actual Budget.

## Authentication

- Use the same password-based authentication as the connected Actual Budget
  instance (`ACTUAL_PASSWORD` env var).
- Login page prompts for the Actual Budget password.
- Session maintained via a signed JWT cookie (no additional user database).
- All API routes and pages require authentication except the login page.

## Core Data Model

### Classification Result (stored in SQLite)

Each dry-run classification produces a record with:

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Unique classification ID |
| transactionId | string | Actual Budget transaction ID |
| date | string | Transaction date |
| amount | number | Transaction amount (cents) |
| payee | string | Payee name |
| importedPayee | string | Raw imported payee |
| notes | string | Transaction notes |
| accountName | string | Account name |
| suggestedCategoryId | string | LLM-suggested category ID |
| suggestedCategoryName | string | LLM-suggested category name |
| suggestedCategoryGroup | string | Category group name |
| classificationType | string | "existing", "new", or "rule" |
| matchedRuleName | string? | Rule name if type is "rule" |
| newCategoryName | string? | Suggested name if type is "new" |
| newGroupName | string? | Suggested group if type is "new" |
| newGroupIsNew | boolean? | Whether group is new |
| confidence | string? | Reserved for future confidence scoring |
| status | enum | "pending", "approved", "rejected" |
| classifiedAt | datetime | When the LLM classified this |
| reviewedAt | datetime? | When a user reviewed this |
| appliedAt | datetime? | When it was written to Actual Budget |
| runId | string | Groups classifications from the same run |

## Pages / Views

### 1. Dashboard (/)

- Summary cards:
  - Total pending classifications
  - Total approved (not yet applied)
  - Total applied
  - Total rejected
  - Last classification run timestamp
- Recent classification runs with transaction counts per run.
- Quick action: "Apply All Approved" button.

### 2. Classifications List (/classifications)

Table view of classification results with:

- Columns: Date, Payee, Amount, Account, Suggested Category, Type, Status
- Sortable by any column
- Filterable by:
  - Status (pending/approved/rejected/applied)
  - Account
  - Category / Category Group
  - Classification type (existing/new/rule)
  - Date range
  - Amount range
  - Payee (text search)
  - Run ID / run date
- Pagination (50 per page default)

### 3. Transaction Review Actions

Per-transaction:
- Approve (accept the suggested category)
- Reject (mark as rejected, will not be applied)
- Change category (approve with a different category than suggested)

Batch/bulk:
- Select multiple transactions via checkboxes
- "Approve Selected" / "Reject Selected" buttons
- "Select All" (on current page) / "Select All Matching Filter"
- Approve/reject all results from a specific filter (e.g., "approve all
  where payee contains 'Walmart' and category is 'Groceries'")

### 4. Apply Approved Classifications

- "Apply" action writes approved classifications to Actual Budget via the
  `@actual-app/api`:
  - Calls `updateTransactionNotesAndCategory()` for each approved record
  - Updates the classification record status to "applied" with timestamp
- Can apply individually, by selection, or in bulk ("Apply All Approved")
- Shows confirmation dialog before applying with count of affected transactions
- If a transaction has been modified in Actual Budget since classification
  (e.g., user already categorized it manually), skip it and flag as "stale"

### 5. Service Controls

- Toggle dry-run mode on/off (controls whether the cron job writes directly
  or stores for review)
- Trigger a classification run manually (on-demand, not waiting for cron)
- View current cron schedule
- View current LLM provider/model configuration (read-only)
- View feature flags status (read-only)

### 6. Classification History (/history)

- Past runs listed by date/time
- Per-run stats: total classified, approved, rejected, applied, accuracy
- Accuracy = approved / (approved + rejected) per run

## Technical Architecture

### Backend

- Express.js HTTP server added to the existing actual-ai Node.js app
- Runs on a configurable port (default 3000, env `REVIEW_UI_PORT`)
- SQLite database for classification storage (file in the data volume)
- REST API endpoints:
  - `POST /api/auth/login` - authenticate with Actual Budget password
  - `GET /api/classifications` - list with filters, sorting, pagination
  - `GET /api/classifications/:id` - single classification detail
  - `PATCH /api/classifications/:id` - update status (approve/reject)
  - `POST /api/classifications/batch` - batch status update
  - `POST /api/classifications/apply` - apply approved to Actual Budget
  - `GET /api/categories` - list categories from Actual Budget
  - `GET /api/runs` - list classification runs
  - `GET /api/stats` - dashboard statistics
  - `POST /api/classify` - trigger manual classification run
  - `GET /api/config` - read-only service configuration

### Frontend

- Server-rendered HTML with minimal client-side JS (no heavy SPA framework)
- Use a lightweight approach: EJS or Handlebars templates + vanilla JS + CSS
- Mobile-responsive layout
- Clean, functional design (similar to Actual Budget's aesthetic)

### Integration with Existing Classification Pipeline

- Modify the transaction processor to store results in SQLite instead of
  (or in addition to) writing directly to Actual Budget
- When dry-run is enabled: store all results as "pending" in SQLite
- When dry-run is disabled: still store in SQLite (as "applied") for history,
  but also write directly to Actual Budget as before
- The existing cron schedule and classify-on-startup behavior remain unchanged

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| REVIEW_UI_PORT | 3000 | Port for the review UI web server |
| REVIEW_UI_ENABLED | true | Enable/disable the review UI |

## Deployment Considerations

- The container now exposes a port (3000) for the web UI
- Will need a Caddy reverse proxy route for internal access
- Will need a Pi-hole DNS record
- The SQLite database lives in the same data volume as the Actual Budget
  cache (`/tmp/actual-ai/`)

## Non-Goals (Out of Scope)

- Multi-user access control (single password auth is sufficient)
- Real-time WebSocket updates (polling or manual refresh is fine)
- Custom prompt editing from the UI
- Training/fine-tuning the LLM from the UI
