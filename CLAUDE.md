# actual-ai

AI-powered transaction classifier for [Actual Budget](https://actualbudget.org/).
Runs as a Docker container alongside Actual Budget Server, classifying
uncategorized transactions via LLM (OpenAI/Azure, Anthropic, Google, Ollama,
OpenRouter, Groq). Includes a Review UI for human approval before applying.

**Active work**: Receipt/OCR integration with Veryfi to enable per-line-item
classification and split transactions.

## Key Documentation

| Doc | Path |
|-----|------|
| Requirements spec (receipt integration) | `docs/RECEIPT-INTEGRATION-REQUIREMENTS.md` |
| Implementation plan (receipt integration) | `docs/RECEIPT-INTEGRATION-PLAN.md` |
| Review UI requirements | `docs/REVIEW-UI-REQUIREMENTS.md` |
| Project handoff notes | `docs/HANDOFF.md` |
| Upstream README | `README.md` |

## Project Structure

```
app.ts                          Entry point (cron, classification, web server)
src/
  config.ts                     Env vars, feature flags
  container.ts                  DI wiring for all services
  actual-ai.ts                  Main orchestrator
  actual-api-service.ts         Actual Budget API wrapper
  transaction-service.ts        Transaction processing pipeline
  llm-service.ts                LLM request orchestration + rate limiting
  prompt-generator.ts           Handlebars prompt builder
  transaction/                  Batch processing, filtering, strategies
  templates/prompt.hbs          Classification prompt template
  veryfi/                       Veryfi client (auth, API, types) - COMPLETE
  web/                          Express server, SQLite store, auth, views
  receipt/                      (planned) Connector framework, matching, splits
```

## Tech Stack

TypeScript, Node 22, Express 5, better-sqlite3 (WAL), Handlebars,
Vercel AI SDK (`ai` package), Docker (alpine). Dev: Jest, ESLint.

## Key Patterns

- **DI container** (`container.ts`): all services wired at startup
- **Strategy pattern**: `transaction/processing-strategy/` for classification types
- **Feature flags**: JSON array in `FEATURES` env var; checked via `isFeatureEnabled()`
- **Note tags**: `#actual-ai` (classified), `#actual-ai-miss` (failed), `#actual-ai-receipt` (planned)
- **Data dir lock**: `/tmp/actual-ai/.actual-ai.lock` prevents concurrent runs
- **SQLite**: `classifications.db` for review workflow; `receipts.db` planned

## Veryfi Integration Notes

The Veryfi client (`src/veryfi/`) uses the **internal web API**
(`iapi.veryfi.com/api/v7`), not the official developer API. Auth is a 5-step
browser login with TOTP MFA. Credentials: `VERYFI_USERNAME`, `VERYFI_PASSWORD`,
`VERYFI_TOTP_SECRET`. TOTP anti-replay logic prevents code reuse across
30-second windows.

**Data quality** (from 455-receipt corpus analysis):
- Use `stamp_date` not `date`; use `line_items[].total` not `.price` (84% zero)
- `business_id` for vendor dedup (not `business_name`)
- 46% of receipts: `total != subtotal + tax + tip - discount`
- Line-item tax always 0 -- tax only at receipt level

## Related Project

Sister project `../veryfi/` contains the original Python Veryfi client and
the corpus analysis (`c-d-veryfi-knowledge-transfer/analysis/FINDINGS.md`).
