#!/usr/bin/env python3
"""
scripts/ai_review.py
────────────────────
Sends the PR diff to Bob Shell (non-interactive mode) and captures
the AI-generated review as a Markdown file.

Bob Shell is invoked via subprocess with:
  - BOBSHELL_API_KEY set in the environment (from GitHub Secrets)
  - --auth-method api-key
  - -p  "<structured prompt>"

The output is written to --output for review.py to embed as an AI
summary section in the final PR comment.

Usage
-----
python scripts/ai_review.py \
    --diff   pr.diff \
    --files  "src/foo.py src/bar.py" \
    --output ai-review.md
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import textwrap
from pathlib import Path

# Maximum number of diff lines we send to Bob.
# Large diffs are truncated to avoid exceeding context limits.
MAX_DIFF_LINES = 400

# Bob Shell binary name (on PATH after install)
BOB_BIN = "bob"


def build_prompt(diff_content: str, files: list[str]) -> str:
    """
    Construct the structured review prompt sent to Bob.

    The prompt asks for a specific Markdown format so that the output
    can be embedded directly into the PR comment without post-processing.
    """
    file_list = ", ".join(files) if files else "changed Python files"

    return textwrap.dedent(f"""\
        You are an expert code reviewer performing a security and quality review
        for a pull request.  Review the following unified diff carefully.

        Changed files: {file_list}

        Your task:
        1. Identify any bugs, logic errors, security vulnerabilities, or code
           quality issues that a human reviewer might miss.
        2. Pay special attention to: SQL injection, hardcoded secrets, missing
           input validation, improper exception handling, missing authentication
           or authorisation checks, insecure HTTP usage, and PII handling.
        3. For each issue found, provide:
           - A one-line title
           - The severity: CRITICAL / HIGH / MEDIUM / LOW
           - A plain-English explanation (2–3 sentences max)
           - A concrete fix (code snippet or clear instruction)
        4. End with a short overall assessment paragraph (3–5 sentences).

        Format your entire response as Markdown with this structure:

        ### AI Review Summary
        <overall assessment paragraph here>

        ### AI-Detected Issues
        For each issue use exactly this format:
        **[SEVERITY] Title**
        *File/line (if known):* `path:line`
        **Explanation:** ...
        **Fix:** ...

        If you find no issues, say: "No additional issues detected beyond static analysis."

        Here is the diff:

        ```diff
        {diff_content}
        ```
    """)


def run_bob(prompt: str) -> str:
    """
    Invoke Bob Shell in non-interactive mode and return its stdout output.

    Raises RuntimeError if Bob Shell is not installed or the call fails.
    """
    api_key = os.environ.get("BOBSHELL_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "BOBSHELL_API_KEY environment variable is not set. "
            "Add it as a GitHub Secret named BOB_API_KEY."
        )

    cmd = [BOB_BIN, "--accept-license", "-p", prompt]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=180,          # 3-minute timeout for the AI call
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"Bob Shell binary '{BOB_BIN}' not found on PATH. "
            "Ensure the 'Install Bob Shell' step ran successfully."
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Bob Shell timed out after 180 seconds.")

    if result.returncode != 0:
        # Surface Bob's stderr so the Actions log shows what went wrong
        stderr_preview = (result.stderr or "")[:500]
        raise RuntimeError(
            f"Bob Shell exited with code {result.returncode}.\n"
            f"stderr: {stderr_preview}"
        )

    return result.stdout.strip()


def truncate_diff(diff_text: str, max_lines: int) -> str:
    """Return at most max_lines lines of the diff, with a truncation notice."""
    lines = diff_text.splitlines()
    if len(lines) <= max_lines:
        return diff_text
    kept = lines[:max_lines]
    kept.append(
        f"\n... (diff truncated at {max_lines} lines — "
        f"{len(lines) - max_lines} additional lines not shown) ..."
    )
    return "\n".join(kept)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run an AI-powered code review using Bob Shell."
    )
    parser.add_argument("--diff",   required=True, help="Path to the unified diff file (pr.diff)")
    parser.add_argument("--files",  required=True, help="Space-separated list of changed files")
    parser.add_argument("--output", required=True, help="Output Markdown file for the AI review")
    args = parser.parse_args()

    diff_path = Path(args.diff)
    if not diff_path.exists():
        print(f"WARNING: diff file '{diff_path}' not found — skipping AI review.", file=sys.stderr)
        Path(args.output).write_text(
            "_AI review skipped: diff file not available._\n", encoding="utf-8"
        )
        return

    diff_content = diff_path.read_text(encoding="utf-8", errors="replace")
    if not diff_content.strip():
        print("WARNING: diff is empty — skipping AI review.", file=sys.stderr)
        Path(args.output).write_text(
            "_AI review skipped: no Python changes detected in this PR._\n", encoding="utf-8"
        )
        return

    diff_content = truncate_diff(diff_content, MAX_DIFF_LINES)
    files = [f for f in args.files.split() if f.endswith(".py")]

    prompt = build_prompt(diff_content, files)

    print(f"Sending {len(diff_content.splitlines())} diff lines to Bob Shell for AI review …")

    try:
        ai_output = run_bob(prompt)
    except RuntimeError as exc:
        # Don't fail the whole workflow if the AI step fails —
        # the structured linter report is still useful.
        print(f"WARNING: AI review failed — {exc}", file=sys.stderr)
        Path(args.output).write_text(
            f"_AI review unavailable: {exc}_\n", encoding="utf-8"
        )
        return

    Path(args.output).write_text(ai_output, encoding="utf-8")
    print(f"AI review written to {args.output} ({len(ai_output.splitlines())} lines).")


if __name__ == "__main__":
    main()
