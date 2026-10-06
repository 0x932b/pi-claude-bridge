// Which Claude Code session each pi session last ran on, persisted across processes.
//
// The bridge's pi-session → CC-session mirror (sharedSessions in index.ts) is
// process-local. A new pi process (restart, `pi --continue`, `pi -p` per turn)
// therefore rebuilds with no previous session id, so readCarriedAttachments has
// nothing to read: the session-start context CC wrote after the first prompt
// (environment, session_context, date, ...) is lost, CC re-attaches it to the
// NEWEST prompt, and the whole history misses the prompt cache.
//
// This file answers "which CC session did this pi session last use, in this cwd?"
// so a first-turn rebuild can carry attachments from it, and, when the link also
// records a fingerprint of the pi history that session holds, lets the first turn
// RESUME it instead of rebuilding (see lookupResumableLink). A rebuild rewrites the
// history from pi's copy, which never byte-matches what Claude Code sent (added
// tool defaults, interrupt markers, attachments CC wrote mid-session), so it
// re-caches the whole conversation; resuming CC's own file keeps the cache.
// What guards a stale or wrong link for carrying is the same check the in-process
// rebuild relies on: placeCarriedAttachments drops any attachment whose prompt
// text no longer matches its ordinal, and a missing session file yields none. A
// link from another branch of the same pi session (after /tree) can still carry
// an attachment whose prompt text is the same in both branches; the in-process
// rebuild has that same exposure when it reads `previousSessionId` after a /tree.
// Concurrent pi processes can lose each other's update (read-modify-write without
// a lock); a lost link only means that rebuild carries nothing, the old behavior.

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The pi history (system messages excluded) a CC session holds: its first
 *  `count` messages hash to `hash`. */
export type HistoryFingerprint = { count: number; hash: string };
/** `rebuildPending`: the mirror was marked to rebuild (abort, missed steer,
 *  history rewrite) when last written, so its CC file must not be resumed.
 *  `pid`: the pi process that wrote the link. */
type Link = { ccSessionId: string; cwd: string; at: number; fingerprint?: HistoryFingerprint; rebuildPending?: boolean; pid?: number };
type Links = Record<string, Link>;

/** Bounded so the file cannot grow without limit; the oldest links go first. */
const MAX_LINKS = 500;

function linksPath(): string {
	return process.env.CLAUDE_BRIDGE_SESSION_LINKS_PATH || join(getAgentDir(), "claude-bridge-sessions.json");
}

function readLinks(): Links {
	try {
		const parsed = JSON.parse(readFileSync(linksPath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Links) : {};
	} catch {
		return {};
	}
}

// Last value written per pi session in THIS process, so the per-turn cursor
// updates that also go through setSessionStateFor do not rewrite the file.
// Bounded like the file: cleared wholesale past the cap (a cleared entry only
// costs one redundant write).
const written = new Map<string, string>();

/** Remember that `piSessionId` now runs on `ccSessionId` in `cwd`. Best effort:
 *  a failed write only means a later restart carries nothing, the old behavior. */
export function recordSessionLink(
	piSessionId: string | null | undefined,
	ccSessionId: string,
	cwd: string,
	fingerprint?: HistoryFingerprint,
	rebuildPending?: boolean,
): void {
	if (!piSessionId) return;
	const key = `${ccSessionId}\0${cwd}\0${fingerprint?.count ?? ""}\0${fingerprint?.hash ?? ""}\0${rebuildPending ? 1 : 0}`;
	if (written.get(piSessionId) === key) return;
	try {
		const links = readLinks();
		links[piSessionId] = { ccSessionId, cwd, at: Date.now(), pid: process.pid, ...(fingerprint ? { fingerprint } : {}), ...(rebuildPending ? { rebuildPending } : {}) };
		const kept = Object.entries(links).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_LINKS);
		const path = linksPath();
		mkdirSync(dirname(path), { recursive: true });
		// Write-then-rename so a concurrent reader in another pi process never
		// sees a half-written file.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
		renameSync(tmp, path);
		if (written.size >= MAX_LINKS) written.clear();
		written.set(piSessionId, key);
	} catch {
		/* best effort, see above */
	}
}

/** The CC session `piSessionId` last ran on in `cwd`, if one was recorded. */
export function lookupSessionLink(piSessionId: string | null | undefined, cwd: string): string | undefined {
	if (!piSessionId) return undefined;
	const link = readLinks()[piSessionId];
	return link && link.cwd === cwd && typeof link.ccSessionId === "string" ? link.ccSessionId : undefined;
}

/** The CC session `piSessionId` last ran on in `cwd`, with the fingerprint of the
 *  history it holds, if it can be resumed as-is: a fingerprint was recorded, no
 *  rebuild was pending, and the process that wrote the link is this one or gone.
 *  A live other process (the same pi session open in two terminals) may still
 *  append to that CC file, and two writers would interleave their turns in it;
 *  rebuilding gives this process a file of its own, the behavior before links.
 *  The caller still has to match the fingerprint against pi's current history. */
export function lookupResumableLink(
	piSessionId: string | null | undefined,
	cwd: string,
): { ccSessionId: string; fingerprint: HistoryFingerprint } | undefined {
	if (!piSessionId) return undefined;
	const link = readLinks()[piSessionId];
	if (!link || link.cwd !== cwd || typeof link.ccSessionId !== "string" || link.rebuildPending) return undefined;
	if (typeof link.pid !== "number" || (link.pid !== process.pid && processAlive(link.pid))) return undefined;
	const fp = link.fingerprint;
	if (!fp || typeof fp.count !== "number" || typeof fp.hash !== "string") return undefined;
	return { ccSessionId: link.ccSessionId, fingerprint: fp };
}

/** Fingerprint of a pi history: role, content and tool-result identity of each
 *  message, in order. Fields pi sets around a message (usage, timestamps, model)
 *  are left out so a history reloaded from disk hashes like the live one. */
export function historyFingerprint(messages: readonly unknown[]): HistoryFingerprint {
	const hash = createHash("sha256");
	for (const message of messages) {
		const m = message as { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
		hash.update(JSON.stringify([m.role, m.content, m.toolCallId ?? null, m.isError ?? null]));
		hash.update("\n");
	}
	return { count: messages.length, hash: hash.digest("hex") };
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists but belongs to someone else, so it is alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
