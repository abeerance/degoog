// ClearURLs rules, applied on top of the static TRACKING_PARAMS list in url-normalize.ts.
//
// The static list covers ad-click identifiers (gclid, fbclid, msclkid...) and the utm_ prefix, which
// is most of what a search result carries. It does not cover site-specific tracking, which is where
// the rest lives: Amazon's ref and pd_rd_*, eBay's _trksid, LinkedIn's trk, Spotify's si. ClearURLs
// is the maintained community ruleset for exactly that, 206 providers and 733 rules at the time of
// writing, and it also unwraps redirector links so a result points at its real destination.
//
// The ruleset is fetched, never vendored, because it changes as sites change. Everything about that
// fetch is designed so a bad or absent download degrades to "the static list only" rather than to
// "no cleaning" or "a crash": load from disk at startup, refresh once a day, validate before
// installing, and keep the last good copy forever if the network is unavailable.

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../utils/logger";

const RULES_URL = "https://rules2.clearurls.xyz/data.minify.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
// Roughly half the 206 providers observed, the same "refuse a suspiciously small list" rule used for
// blocklists elsewhere. A truncated download or an upstream error page is otherwise
// indistinguishable from a working ruleset.
const MIN_PROVIDERS = 100;

interface ClearUrlsProvider {
  urlPattern: string;
  completeProvider?: boolean;
  rules?: string[];
  rawRules?: string[];
  referralMarketing?: string[];
  exceptions?: string[];
  redirections?: string[];
}

interface CompiledProvider {
  urlPattern: RegExp;
  rules: RegExp[];
  rawRules: RegExp[];
  exceptions: RegExp[];
  redirections: RegExp[];
}

let _providers: CompiledProvider[] = [];
let _timer: ReturnType<typeof setTimeout> | undefined;

// ClearURLs anchors every rule as a whole-value match. Compiling once at load keeps the hot path to
// a regex test per provider rather than a construction per URL.
const _compile = (raw: Record<string, ClearUrlsProvider>): CompiledProvider[] => {
  const out: CompiledProvider[] = [];
  for (const [name, p] of Object.entries(raw)) {
    if (!p?.urlPattern) continue;
    try {
      out.push({
        urlPattern: new RegExp(p.urlPattern, "i"),
        // referralMarketing entries are stripped too: they are tracking parameters that happen to
        // pay someone, which is not a reason to keep them in a search result.
        rules: [...(p.rules ?? []), ...(p.referralMarketing ?? [])].map(
          (r) => new RegExp(`^${r}$`, "i"),
        ),
        rawRules: (p.rawRules ?? []).map((r) => new RegExp(r, "i")),
        exceptions: (p.exceptions ?? []).map((r) => new RegExp(r, "i")),
        redirections: (p.redirections ?? []).map((r) => new RegExp(r, "i")),
      });
    } catch (err) {
      // One malformed provider must not cost the other 205.
      logger.debug("search", `clearurls: skipping provider "${name}"`, err);
    }
  }
  return out;
};

const _validate = (text: string): CompiledProvider[] => {
  const parsed = JSON.parse(text) as { providers?: Record<string, ClearUrlsProvider> };
  if (!parsed?.providers || typeof parsed.providers !== "object")
    throw new Error("no providers object");
  const compiled = _compile(parsed.providers);
  if (compiled.length < MIN_PROVIDERS)
    throw new Error(`only ${compiled.length} providers, floor ${MIN_PROVIDERS}`);
  return compiled;
};

const _cacheDir = (): string =>
  join(process.env.DEGOOG_DATA_DIR ?? join(process.cwd(), "data"), "clearurls");
const _cacheFile = (): string => join(_cacheDir(), "data.min.json");
const _metaFile = (): string => join(_cacheDir(), "meta.json");

// rename(2) is atomic only within a filesystem, so the temp file is written beside its target.
async function _writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

async function _refresh(): Promise<void> {
  let meta: { sha256?: string; fetchedAt?: number } = {};
  try {
    meta = JSON.parse(await readFile(_metaFile(), "utf-8"));
  } catch {
    // no meta yet
  }
  try {
    const res = await fetch(RULES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 === meta.sha256) {
      logger.debug("search", "clearurls: ruleset unchanged");
      return;
    }
    const compiled = _validate(body);
    await mkdir(_cacheDir(), { recursive: true });
    await _writeAtomic(_cacheFile(), body);
    await _writeAtomic(_metaFile(), JSON.stringify({ sha256, fetchedAt: Date.now() }));
    _providers = compiled;
    logger.info("search", `clearurls: ${compiled.length} providers loaded`);
  } catch (err) {
    // The last good ruleset stays in memory. Never fall back to an empty one: that would silently
    // turn cleaning off while every health signal stayed green.
    logger.warn("search", "clearurls: refresh failed, keeping current ruleset", err);
  }
}

/**
 * Load the cached ruleset, then refresh on a daily cadence.
 *
 * Safe to call more than once: the timer handle is module-scoped and cleared first, so a repeated
 * call replaces the schedule rather than adding a second one.
 */
export async function initClearUrls(): Promise<void> {
  try {
    _providers = _validate(await readFile(_cacheFile(), "utf-8"));
    logger.debug("search", `clearurls: ${_providers.length} providers from cache`);
  } catch {
    // No usable cache; the fetch below fills it. Until then the static list does the work.
  }
  await _refresh();
  clearTimeout(_timer);
  _timer = setTimeout(function tick() {
    void _refresh().finally(() => {
      _timer = setTimeout(tick, DAY_MS);
    });
  }, DAY_MS);
}

/** Test seam: load rules from an object instead of the network. */
export function loadClearUrlsForTest(raw: Record<string, ClearUrlsProvider>): void {
  _providers = _compile(raw);
}

/**
 * Apply the ClearURLs ruleset to a single URL.
 *
 * Returns the input unchanged when no provider matches, when the ruleset has not loaded, or when
 * anything throws. Cleaning is best-effort by design: a bad rule must never cost the result.
 */
export const applyClearUrls = (url: string): string => {
  if (_providers.length === 0) return url;
  let current = url;
  // A redirector can wrap another redirector. Bounded so a malformed rule cannot spin.
  for (let hop = 0; hop < 3; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    let redirected: string | null = null;
    for (const p of _providers) {
      if (!p.urlPattern.test(current)) continue;
      if (p.exceptions.some((e) => e.test(current))) continue;

      for (const r of p.redirections) {
        const m = current.match(r);
        if (m?.[1]) {
          try {
            redirected = decodeURIComponent(m[1]);
          } catch {
            redirected = m[1];
          }
          break;
        }
      }
      if (redirected) break;

      for (const key of Array.from(parsed.searchParams.keys())) {
        if (p.rules.some((r) => r.test(key))) parsed.searchParams.delete(key);
      }
      for (const raw of p.rawRules) {
        parsed = new URL(parsed.href.replace(raw, ""));
      }
    }
    if (!redirected) return parsed.href;
    current = redirected;
  }
  return current;
};
