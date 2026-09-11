#!/usr/bin/env python3
"""
scripts/review.py
─────────────────
Aggregates Bandit, Pylint, and Pyflakes reports plus a custom
rule-set into a single prioritised Markdown finding report
suitable for posting as a GitHub PR comment.

Usage
-----
python scripts/review.py \
    --bandit   bandit-report.json \
    --pylint   pylint-report.json \
    --pyflakes pyflakes-report.txt \
    --files    "src/foo.py src/bar.py" \
    --pr       42 \
    --title    "Add payment handler" \
    --author   "alice" \
    --sha      "abc1234" \
    --output   review-comment.md
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

# ─────────────────────────────────────────────
# Data model
# ─────────────────────────────────────────────

Severity = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]

SEVERITY_EMOJI: dict[Severity, str] = {
    "CRITICAL": "🔴",
    "HIGH":     "🟠",
    "MEDIUM":   "🟡",
    "LOW":      "🔵",
}

SEVERITY_ORDER: dict[Severity, int] = {
    "CRITICAL": 0,
    "HIGH":     1,
    "MEDIUM":   2,
    "LOW":      3,
}


@dataclass
class Finding:
    severity: Severity
    category: str          # e.g. "Security", "Bug", "Quality"
    title: str
    explanation: str
    fix: str
    file: str = ""
    line: int = 0
    rule: str = ""

    @property
    def badge(self) -> str:
        return f"{SEVERITY_EMOJI[self.severity]} {self.severity}"


# ─────────────────────────────────────────────
# Bandit parser
# ─────────────────────────────────────────────

BANDIT_SEVERITY_MAP = {
    "HIGH":   "CRITICAL",
    "MEDIUM": "CRITICAL",   # hardcoded secrets, insecure configs → always critical
    "LOW":    "MEDIUM",
}

BANDIT_RULE_TITLES: dict[str, tuple[str, str, str]] = {
    # test_id: (title, explanation, fix)
    "B105": (
        "Hardcoded password / secret",
        "A secret or API key is embedded directly in source code. "
        "Anyone with read access to the repository can extract it.",
        "Move the value to an environment variable or a secrets manager "
        "(e.g. `os.environ['SECRET_KEY']`). Rotate the exposed credential immediately.",
    ),
    "B106": (
        "Hardcoded password / secret",
        "A secret or API key is embedded directly in source code. "
        "Anyone with read access to the repository can extract it.",
        "Move the value to an environment variable or a secrets manager "
        "(e.g. `os.environ['SECRET_KEY']`). Rotate the exposed credential immediately.",
    ),
    "B107": (
        "Hardcoded password / secret",
        "A secret or API key is embedded directly in source code. "
        "Anyone with read access to the repository can extract it.",
        "Move the value to an environment variable or a secrets manager. "
        "Rotate the exposed credential immediately.",
    ),
    "B608": (
        "SQL injection via string formatting",
        "User-controlled input is concatenated directly into a SQL query using an f-string "
        "or `%` / `.format()`. An attacker can escape the string and run arbitrary SQL.",
        "Use parameterised queries: `cursor.execute('SELECT … WHERE id = ?', (user_id,))`.",
    ),
    "B113": (
        "HTTP request without timeout",
        "A `requests` call has no `timeout` parameter. The process will hang indefinitely "
        "if the remote server is slow or unreachable, exhausting connection pools.",
        "Add `timeout=(connect_seconds, read_seconds)`, e.g. `timeout=(5, 30)`.",
    ),
    "B501": (
        "Disabled TLS certificate verification",
        "`verify=False` disables TLS certificate validation, making the connection "
        "vulnerable to man-in-the-middle attacks.",
        "Remove `verify=False` or supply a CA bundle path.",
    ),
    "B110": (
        "Bare `except: pass` suppresses all exceptions",
        "A `try/except: pass` silently discards exceptions, hiding bugs and making "
        "incident diagnosis impossible.",
        "Catch only the specific exception types you expect; re-raise or log unexpected ones.",
    ),
}


def parse_bandit(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not path.exists():
        return findings

    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return findings

    for issue in data.get("results", []):
        test_id: str = issue.get("test_id", "")
        bandit_sev: str = issue.get("issue_severity", "LOW").upper()
        severity: Severity = BANDIT_SEVERITY_MAP.get(bandit_sev, "LOW")  # type: ignore[assignment]

        known = BANDIT_RULE_TITLES.get(test_id)
        if known:
            title, explanation, fix = known
        else:
            title = issue.get("test_name", test_id)
            explanation = issue.get("issue_text", "")
            fix = "Review and resolve the flagged pattern."

        findings.append(
            Finding(
                severity=severity,
                category="Security",
                title=title,
                explanation=explanation,
                fix=fix,
                file=issue.get("filename", ""),
                line=issue.get("line_number", 0),
                rule=test_id,
            )
        )

    return findings


# ─────────────────────────────────────────────
# Pylint parser
# ─────────────────────────────────────────────

PYLINT_TYPE_SEVERITY: dict[str, Severity] = {
    "error":      "HIGH",
    "fatal":      "CRITICAL",
    "warning":    "MEDIUM",
    "convention": "LOW",
    "refactor":   "LOW",
}

PYLINT_MSG_TITLES: dict[str, tuple[str, str]] = {
    # msg-id: (title, fix)
    "W0611": ("Unused import", "Remove the unused import."),
    "W0612": ("Unused variable", "Remove or use the variable."),
    "E0001": ("Syntax error", "Fix the syntax error before merging."),
    "E0102": ("Class/function redefinition", "Rename or remove the duplicate definition."),
    "W0703": (
        "Catching too-broad exception (Exception)",
        "Catch specific exception types instead of the base `Exception` class.",
    ),
    "W0719": (
        "Raising too-broad exception",
        "Raise a specific exception type so callers can handle it precisely.",
    ),
    "R0201": ("Method could be a function", "Convert to a `@staticmethod` or module-level function."),
    "C0301": ("Line too long", "Wrap the line to stay under the configured max length."),
    "W0102": (
        "Mutable default argument",
        "Use `None` as default and assign inside the function body.",
    ),
}


def parse_pylint(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not path.exists():
        return findings

    try:
        raw = path.read_text().strip()
        # pylint sometimes emits non-JSON preamble lines; find the JSON array
        start = raw.find("[")
        if start == -1:
            return findings
        data = json.loads(raw[start:])
    except (json.JSONDecodeError, ValueError):
        return findings

    seen: set[str] = set()

    for issue in data:
        msg_id: str = issue.get("message-id", "")
        msg_type: str = issue.get("type", "convention").lower()
        severity: Severity = PYLINT_TYPE_SEVERITY.get(msg_type, "LOW")  # type: ignore[assignment]

        known = PYLINT_MSG_TITLES.get(msg_id)
        title = known[0] if known else issue.get("message", msg_id)
        fix = known[1] if known else "Review and resolve the flagged pattern."

        dedup_key = f"{msg_id}:{issue.get('path', '')}:{issue.get('line', 0)}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        findings.append(
            Finding(
                severity=severity,
                category="Quality",
                title=title,
                explanation=issue.get("message", ""),
                fix=fix,
                file=issue.get("path", ""),
                line=issue.get("line", 0),
                rule=msg_id,
            )
        )

    return findings


# ─────────────────────────────────────────────
# Pyflakes parser
# ─────────────────────────────────────────────

def parse_pyflakes(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not path.exists():
        return findings

    for raw_line in path.read_text().splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        # format:  path/file.py:line:col: message
        match = re.match(r"^(.+?):(\d+):\d+: (.+)$", raw_line)
        if not match:
            # fallback: path/file.py:line: message
            match = re.match(r"^(.+?):(\d+): (.+)$", raw_line)
        if not match:
            continue

        filepath, lineno, message = match.group(1), int(match.group(2)), match.group(3)

        if "imported but unused" in message:
            title = "Unused import"
            fix = "Remove the import or add a `# noqa` comment if intentional."
            severity: Severity = "LOW"
        elif "undefined name" in message:
            title = "Undefined name (NameError at runtime)"
            fix = "Define or import the name before it is used."
            severity = "HIGH"
        elif "redefinition of unused" in message:
            title = "Redefined name (previous import or definition unused)"
            fix = "Remove the earlier definition or the later redefinition."
            severity = "MEDIUM"
        else:
            title = "Code issue detected by Pyflakes"
            fix = "Review and resolve the flagged pattern."
            severity = "LOW"

        findings.append(
            Finding(
                severity=severity,
                category="Logic",
                title=title,
                explanation=message,
                fix=fix,
                file=filepath,
                line=lineno,
                rule="pyflakes",
            )
        )

    return findings


# ─────────────────────────────────────────────
# Custom AST rules (supplement the linters)
# ─────────────────────────────────────────────

def _collect_raise_for_status_vars(body: list[ast.stmt]) -> set[str]:
    """
    Return the set of variable names that have `.raise_for_status()` called on them
    anywhere within a flat list of statements (does not recurse into sub-blocks).
    """
    names: set[str] = set()
    for stmt in body:
        for node in ast.walk(stmt):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "raise_for_status"
                and isinstance(node.func.value, ast.Name)
            ):
                names.add(node.func.value.id)
            # Also accept: if response.status_code ...
            if (
                isinstance(node, ast.Attribute)
                and node.attr == "status_code"
                and isinstance(node.value, ast.Name)
            ):
                names.add(node.value.id)
    return names


def _iter_function_bodies(tree: ast.AST):
    """Yield (body, parent_node) for every function / method in the tree."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.body, node


def run_custom_rules(files: list[str]) -> list[Finding]:
    """
    Hand-written AST checks that catch patterns the three linters miss:
      - Missing HTTP status-code checks after requests calls
      - PII written to flat files
    """
    findings: list[Finding] = []

    for filepath in files:
        path = Path(filepath)
        if not path.exists() or path.suffix != ".py":
            continue

        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=filepath)
        except SyntaxError:
            continue

        # ── Rule CR-01: HTTP status not checked ──────────────────────────────
        # For every function body, collect which response variables have
        # raise_for_status() called on them, then flag the ones that don't.
        for body, _func in _iter_function_bodies(tree):
            checked_vars = _collect_raise_for_status_vars(body)
            for stmt in body:
                for node in ast.walk(stmt):
                    if not isinstance(node, ast.Assign):
                        continue
                    for target in node.targets:
                        if not isinstance(target, ast.Name):
                            continue
                        val = node.value
                        if (
                            isinstance(val, ast.Call)
                            and isinstance(val.func, ast.Attribute)
                            and val.func.attr in ("get", "post", "put", "patch", "delete")
                            and isinstance(val.func.value, ast.Name)
                            and val.func.value.id == "requests"
                            and target.id not in checked_vars
                        ):
                            findings.append(
                                Finding(
                                    severity="HIGH",
                                    category="Bug",
                                    title="HTTP response status not validated",
                                    explanation=(
                                        f"`{target.id}` stores an HTTP response but "
                                        "`.raise_for_status()` or a `status_code` check is never "
                                        "called. A 4xx or 5xx response is silently treated as success."
                                    ),
                                    fix=(
                                        "Add `response.raise_for_status()` immediately after the "
                                        "call, or explicitly check `response.status_code`."
                                    ),
                                    file=filepath,
                                    line=node.lineno,
                                    rule="CR-01",
                                )
                            )

        # ── Rule CR-02: PII / sensitive data in flat file ─────────────────────
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr == "write":
                    findings.append(
                        Finding(
                            severity="HIGH",
                            category="Security",
                            title="Sensitive data written to unencrypted flat file",
                            explanation=(
                                "A `.write()` call may persist PII or financial data to an "
                                "unencrypted flat file. Flat log files are often world-readable "
                                "on shared servers and are excluded from database access controls."
                            ),
                            fix=(
                                "Use structured logging (e.g. Python `logging` module with a "
                                "SIEM-compatible formatter). Never write PII to raw files. "
                                "If a file is required, ensure it is encrypted at rest and "
                                "access-controlled."
                            ),
                            file=filepath,
                            line=node.lineno,
                            rule="CR-02",
                        )
                    )

    # Deduplicate by (rule, file, line)
    seen: set[tuple[str, str, int]] = set()
    deduped: list[Finding] = []
    for f in findings:
        key = (f.rule, f.file, f.line)
        if key not in seen:
            seen.add(key)
            deduped.append(f)

    return deduped


# ─────────────────────────────────────────────
# Report renderer
# ─────────────────────────────────────────────

def render_markdown(
    findings: list[Finding],
    pr_number: int,
    pr_title: str,
    author: str,
    sha: str,
    files: list[str],
    ai_summary: str = "",
) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    short_sha = sha[:7] if sha else "unknown"

    counts: dict[Severity, int] = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in findings:
        counts[f.severity] += 1

    gate_status = (
        "❌ **BLOCKED** — critical issues must be resolved before merge."
        if counts["CRITICAL"] > 0
        else "✅ **PASSED** — no critical issues detected."
    )

    ai_available = bool(ai_summary.strip()) and not ai_summary.strip().startswith("_AI review")

    lines: list[str] = []

    lines.append("## 🤖 Intelligent PR Review Report")
    lines.append("")
    lines.append(f"| | |")
    lines.append(f"|---|---|")
    lines.append(f"| **PR** | #{pr_number} — {pr_title} |")
    lines.append(f"| **Author** | @{author} |")
    lines.append(f"| **Commit** | `{short_sha}` |")
    lines.append(f"| **Scanned at** | {now} |")
    lines.append(f"| **Files reviewed** | {len(files)} |")
    lines.append(f"| **AI review** | {'✅ Bob Shell' if ai_available else '⚠️ unavailable'} |")
    lines.append("")
    lines.append("### Quality Gate")
    lines.append(gate_status)
    lines.append("")

    # ── AI summary section ────────────────────────────────────────────
    if ai_available:
        lines.append("<details>")
        lines.append("<summary><strong>🧠 Bob AI Review</strong> (click to expand)</summary>")
        lines.append("")
        lines.append(ai_summary)
        lines.append("")
        lines.append("</details>")
        lines.append("")

    lines.append("### Static Analysis — Finding Summary")
    lines.append("")
    lines.append("| Severity | Count |")
    lines.append("|---|---|")
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        emoji = SEVERITY_EMOJI[sev]  # type: ignore[index]
        lines.append(f"| {emoji} {sev} | {counts[sev]} |")
    lines.append(f"| **Total** | **{len(findings)}** |")
    lines.append("")

    if not findings:
        lines.append("_No static analysis issues detected. Great work!_ 🎉")
        lines.append("")
        lines.append("---")
        lines.append(
            "_Generated by [Intelligent PR Reviewer](https://github.com) · "
            "Powered by Bob AI · Bandit · Pylint · Pyflakes · Custom AST Rules_"
        )
        return "\n".join(lines)

    lines.append("---")
    lines.append("")
    lines.append("### Detailed Findings")
    lines.append("")

    for idx, f in enumerate(findings, start=1):
        location = f"`{f.file}:{f.line}`" if f.file and f.line else ""
        rule_tag = f"`{f.rule}`" if f.rule else ""
        lines.append(
            f"#### {idx}. {f.badge} · {f.category} · {f.title}"
        )
        if location or rule_tag:
            lines.append(f"> {location}  {rule_tag}")
        lines.append("")
        lines.append(f"**What's wrong:** {f.explanation}")
        lines.append("")
        lines.append(f"**How to fix:** {f.fix}")
        lines.append("")

    lines.append("---")
    lines.append(
        "_Generated by [Intelligent PR Reviewer](https://github.com) · "
        "Powered by Bob AI · Bandit · Pylint · Pyflakes · Custom AST Rules_"
    )

    return "\n".join(lines)


# ─────────────────────────────────────────────
# CLI entry-point
# ─────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate linter reports into a PR review comment.")
    parser.add_argument("--bandit",   required=True,  help="Path to bandit JSON report")
    parser.add_argument("--pylint",   required=True,  help="Path to pylint JSON report")
    parser.add_argument("--pyflakes", required=True,  help="Path to pyflakes text report")
    parser.add_argument("--ai",       default="",     help="Path to Bob AI review Markdown (optional)")
    parser.add_argument("--files",    required=True,  help="Space-separated list of changed files")
    parser.add_argument("--pr",       required=True,  type=int)
    parser.add_argument("--title",    required=True)
    parser.add_argument("--author",   required=True)
    parser.add_argument("--sha",      required=True)
    parser.add_argument("--output",   required=True,  help="Output Markdown file path")
    args = parser.parse_args()

    files = [f for f in args.files.split() if f.endswith(".py")]

    # Load AI summary (optional — gracefully absent if the step failed)
    ai_summary = ""
    if args.ai:
        ai_path = Path(args.ai)
        if ai_path.exists():
            ai_summary = ai_path.read_text(encoding="utf-8").strip()

    findings: list[Finding] = []
    findings += parse_bandit(Path(args.bandit))
    findings += parse_pylint(Path(args.pylint))
    findings += parse_pyflakes(Path(args.pyflakes))
    findings += run_custom_rules(files)

    # Deduplicate across parsers by (title, file, line)
    seen_global: set[tuple[str, str, int]] = set()
    deduped: list[Finding] = []
    for f in findings:
        key = (f.title.lower(), f.file, f.line)
        if key not in seen_global:
            seen_global.add(key)
            deduped.append(f)

    # Sort: CRITICAL → HIGH → MEDIUM → LOW, then by file/line
    deduped.sort(key=lambda f: (SEVERITY_ORDER[f.severity], f.file, f.line))

    report = render_markdown(
        findings=deduped,
        pr_number=args.pr,
        pr_title=args.title,
        author=args.author,
        sha=args.sha,
        files=files,
        ai_summary=ai_summary,
    )

    Path(args.output).write_text(report, encoding="utf-8")
    print(f"Report written to {args.output} ({len(deduped)} findings).")

    # Exit 1 if critical findings exist (picked up by the quality-gate step)
    if any(f.severity == "CRITICAL" for f in deduped):
        sys.exit(1)


if __name__ == "__main__":
    main()
