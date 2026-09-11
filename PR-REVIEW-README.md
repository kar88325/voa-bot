# Intelligent PR Reviewer — AI-Powered Edition

Automated pull request review using **Bob Shell AI** + **Bandit · Pylint · Pyflakes** static analysis.

Every PR targeting `main` receives:
- 🧠 An AI-powered narrative review from Bob Shell (collapsible section)
- 🔴 Structured finding cards sorted by severity (CRITICAL → LOW)
- ❌ A hard quality gate that blocks merge on any CRITICAL finding

---

## Quick Start

### 1. Copy the files into your repository

```
.github/workflows/pr-review.yml   ← the GitHub Action
scripts/ai_review.py               ← Bob Shell AI step
scripts/review.py                  ← report aggregator
```

### 2. Add your Bob API key as a GitHub Secret

1. Go to **bob.ibm.com** → your account → **API keys**
2. Create a new key with **Scope: Inference**
3. In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `BOB_API_KEY`
   - Value: the key you just created

### 3. Grant workflow write permissions

**Settings → Actions → General → Workflow permissions → Read and write permissions**

### 4. Open a PR — the reviewer runs automatically

---

## How it works

```
PR opened / updated
       │
       ▼
Checkout + collect changed .py files
       │
       ├─► Bandit (security scan)       → bandit-report.json
       ├─► Pylint (quality scan)        → pylint-report.json
       ├─► Pyflakes (logic / unused)    → pyflakes-report.txt
       └─► Bob Shell AI (diff review)   → ai-review.md
                         │
                         ▼
              scripts/review.py
          (aggregates all four inputs)
                         │
                         ▼
              review-comment.md
                         │
              ┌──────────┴──────────┐
              │                     │
      Post PR comment        Quality gate check
                             (exit 1 if CRITICAL)
```

---

## Environment variable reference

| Variable | Where | Description |
|---|---|---|
| `BOB_API_KEY` | GitHub Secret | Bob Shell Inference API key |
| `GITHUB_TOKEN` | Auto-injected | Posts the PR comment (no setup needed) |

---

## Files

| File | Purpose |
|---|---|
| `.github/workflows/pr-review.yml` | GitHub Actions workflow |
| `scripts/ai_review.py` | Invokes Bob Shell non-interactively, captures AI review |
| `scripts/review.py` | Parses Bandit/Pylint/Pyflakes + custom AST rules → Markdown report |
| `examples/payment_handler.py` | Demo: intentionally flawed code (11 bugs) |
| `examples/payment_handler_fixed.py` | Demo: corrected version (0 findings) |
