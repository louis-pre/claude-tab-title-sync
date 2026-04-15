#!/usr/bin/env node
// Wrapper around `claude` that captures the terminal-title OSC sequences it
// emits (the AI-generated topic title) and persists them as the session's
// custom title via @anthropic-ai/claude-agent-sdk's renameSession().
//
// Usage:
//   alias claude="/path/to/claude-tab-title-sync/claude-title-sync.mjs"
//
// Env:
//   CLAUDE_REAL_BIN          Override path to the real claude binary
//   CLAUDE_TITLE_SYNC_DEBUG  Set to 1 to log title sync activity to stderr

import { spawn } from "node-pty"
import { renameSession } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const debug = process.env.CLAUDE_TITLE_SYNC_DEBUG === "1"
const log = (...parts) => {
  if (debug) process.stderr.write(`[title-sync] ${parts.join(" ")}\n`)
}

// --- Locate the real claude binary (skip ourselves to avoid recursion) ----
function findRealClaude() {
  if (process.env.CLAUDE_REAL_BIN) return process.env.CLAUDE_REAL_BIN
  let ourPath
  try {
    ourPath = realpathSync(process.argv[1])
  } catch {
    ourPath = process.argv[1]
  }
  let candidates = []
  try {
    candidates = execSync("which -a claude", { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    try {
      if (realpathSync(p) !== ourPath) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

const realClaude = findRealClaude()
if (!realClaude) {
  process.stderr.write(
    "[title-sync] could not locate real `claude` binary in PATH.\n" +
      "[title-sync] set CLAUDE_REAL_BIN=/abs/path/to/claude to override.\n",
  )
  process.exit(127)
}
log("real claude:", realClaude)

// --- Decide whether to inject --session-id --------------------------------
const userArgs = process.argv.slice(2)
const RESUMING_FLAGS = new Set([
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--from-pr",
  "--fork-session",
])
const isResuming = userArgs.some((a) => RESUMING_FLAGS.has(a))
const hasExplicitSessionId = userArgs.includes("--session-id")
const isPrintMode = userArgs.includes("-p") || userArgs.includes("--print")

let sessionId = null
const args = [...userArgs]
if (!isResuming && !hasExplicitSessionId && !isPrintMode) {
  sessionId = randomUUID()
  args.unshift("--session-id", sessionId)
}
log("session at startup:", sessionId ?? "(deferred discovery)")

// --- Spawn claude under a PTY ---------------------------------------------
const cwd = process.cwd()
const claude = spawn(realClaude, args, {
  name: process.env.TERM ?? "xterm-256color",
  cols: process.stdout.columns ?? 80,
  rows: process.stdout.rows ?? 24,
  cwd,
  env: process.env,
})

// stdin: raw + forward (preserve bytes via latin1 round-trip)
const stdinIsTty = process.stdin.isTTY === true
if (stdinIsTty) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", (d) => {
  claude.write(d.toString("binary"))
})

// resize forwarding
process.stdout.on("resize", () => {
  try {
    claude.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  } catch {
    /* pty closed */
  }
})

// signal forwarding
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(sig, () => {
    try {
      claude.kill(sig)
    } catch {
      /* pty closed */
    }
  })
}

// --- OSC title parser -----------------------------------------------------
// Matches OSC 0/1/2 ; <title> ST  where ST is BEL (\x07) or ESC \  (\x1b\\)
const OSC_RE = /\x1b\][012];([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
let pending = ""
let lastTitle = ""

function processChunk(chunk) {
  pending += chunk
  let lastEnd = 0
  let m
  OSC_RE.lastIndex = 0
  while ((m = OSC_RE.exec(pending)) !== null) {
    const title = m[1]
    void maybeRename(title)
    lastEnd = OSC_RE.lastIndex
  }
  // Keep only the tail starting from any partial ESC; cap to bound memory.
  const tail = pending.slice(lastEnd)
  const escIdx = tail.indexOf("\x1b")
  pending = escIdx >= 0 ? tail.slice(escIdx) : ""
  if (pending.length > 4096) pending = pending.slice(-256)
}

// Strip leading ornament chars (Claude's working/idle icon: "* ", "✳ ",
// any braille spinner glyph in U+2800-U+28FF, bullets, dots).
const LEADING_ORNAMENT_RE = /^[\s*✳✦·•◯○●\u2800-\u28FF]+/u

function normalizeTitle(raw) {
  return raw.replace(LEADING_ORNAMENT_RE, "").trim()
}

async function maybeRename(rawTitle) {
  const title = normalizeTitle(rawTitle)
  if (!title) return
  if (title === "Claude Code") return // default idle title — not informative
  if (title === lastTitle) return
  // Claim the title synchronously BEFORE any await so concurrent calls with
  // the same title (common while sessionId discovery is pending on resume)
  // dedupe instead of all firing renameSession in parallel.
  lastTitle = title
  if (sessionId == null) {
    sessionId = await discoverSessionIdFromCwd()
    if (sessionId == null) {
      log("no sessionId yet, dropping title:", title)
      return
    }
    log("discovered sessionId:", sessionId)
  }
  try {
    await renameSession(sessionId, title, { dir: cwd })
    log("renamed →", title)
  } catch (err) {
    log("rename failed:", err.message ?? String(err))
  }
}

claude.onData((data) => {
  process.stdout.write(data)
  processChunk(data)
})

claude.onExit(({ exitCode, signal }) => {
  if (stdinIsTty) {
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode ?? (signal ? 128 + signal : 0))
})

// --- sessionId discovery (used when --resume / --continue) ----------------
let _discoverInflight = null
function discoverSessionIdFromCwd() {
  if (_discoverInflight) return _discoverInflight
  _discoverInflight = (async () => {
    const enc = cwd.replace(/[^A-Za-z0-9]/g, "-")
    const dir = join(homedir(), ".claude", "projects", enc)
    // Retry a few times — the JSONL may not exist yet on the first OSC tick.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        let newest = null
        let newestMtime = 0
        for (const e of entries) {
          try {
            const m = statSync(join(dir, e)).mtimeMs
            if (m > newestMtime) {
              newestMtime = m
              newest = e
            }
          } catch {
            /* ignore */
          }
        }
        if (newest) return newest.replace(/\.jsonl$/, "")
      } catch {
        /* dir may not exist yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return null
  })()
  return _discoverInflight
}
