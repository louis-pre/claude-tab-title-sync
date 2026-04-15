# claude-tab-title-sync

A small PTY wrapper around `claude` ([Claude Code CLI](https://docs.claude.com/en/docs/claude-code)) that captures the terminal-title OSC escape sequences Claude emits with its AI-generated session topic, and persists them as the session's **custom title** via [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)'s `renameSession()`.

## Why

Claude Code already updates your terminal tab title with an AI-generated topic name (e.g. `Refactor user auth flow`), but that name lives only in the terminal — it isn't saved with the session. So when you later run `claude --resume` or browse the session picker, the entries don't carry that helpful title; they fall back to `Claude Code` or the first user prompt.

`/rename` from inside a session would persist a name, but you'd have to do it manually for every session. This wrapper closes the gap automatically: every time Claude updates the terminal title, the wrapper writes that title into the session's JSONL via `renameSession()`, so it shows up in the resume picker on subsequent runs.

## Install

```bash
git clone https://github.com/louis-pre/claude-tab-title-sync.git
cd claude-tab-title-sync
npm install
```

The `postinstall` script chmods `node_modules/node-pty/prebuilds/*/spawn-helper` because npm sometimes drops the +x bit on tarball extraction.

## Use

Add an alias to your shell config so `claude` invokes the wrapper:

```bash
# ~/.zshrc or ~/.bashrc
alias claude="/path/to/claude-tab-title-sync/claude-title-sync.mjs"
```

Reload your shell. Run `claude` normally — interactive sessions, `--resume`, `--continue`, etc. all work.

To bypass the wrapper for a single invocation:

```bash
command claude   # skips the alias
\claude          # also skips the alias
```

## How it works

1. The wrapper spawns the real `claude` binary under a PTY (via `node-pty`) so Claude continues to behave as a fully-interactive TTY app.
2. For new sessions it injects `--session-id <uuid>` so it knows the session ID upfront. For `--resume` / `--continue` it discovers the active session by tailing the newest mtime in `~/.claude/projects/<encoded-cwd>/`.
3. Claude's stdout is forwarded to your terminal unmodified.
4. In parallel, the stream is scanned for OSC `\e]0;TITLE\a`, `\e]1;TITLE\a`, `\e]2;TITLE\a` sequences. Leading ornament glyphs are stripped (Claude prefixes the title with spinner glyphs like `⠂`, `✳`, `* * *` while it works), and the result is passed to `renameSession()`.
5. The default `Claude Code` title and any title identical to the previously-set one are skipped.

## Environment variables

| Var | Purpose |
| --- | --- |
| `CLAUDE_REAL_BIN` | Override the path to the real `claude` binary. Useful if `which -a claude` doesn't find it or finds something else. |
| `CLAUDE_TITLE_SYNC_DEBUG` | Set to `1` to log every captured title and rename attempt to stderr. |

## Caveats

- **Prompt input bar isn't updated.** Claude's `/rename` slash command writes both a `custom-title` and an `agent-name` JSONL entry; the latter drives the prompt input bar label. The Agent SDK's `renameSession()` only writes `custom-title`, so the resume picker and terminal tab show the title but the in-session prompt bar does not. Doable to fix by appending the `agent-name` entry directly — open to PRs.
- **Some duplicate `custom-title` entries may still appear.** The in-process dedup is bulletproof for sequential calls but a small number of identical entries per session still slip through (root cause TBD). The resume picker only cares about the most recent entry, so this is cosmetic.
- **`--print` / non-interactive mode** is unaffected — no PTY, no titles emitted.

## Requirements

- Node.js ≥ 18
- `claude` (Claude Code CLI) installed and on your `PATH`
- macOS or Linux (Windows untested; node-pty supports it but the wrapper hasn't been validated there)

## License

MIT
