#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const REPO_ROOT = join(SCRIPT_DIR, '..');

// Which GitHub repo to pull feeds/prompts from, in priority order:
// 1. FB_REPO env var (e.g. FB_REPO=myuser/follow-builders)
// 2. The git origin of the checkout this script lives in (works for forks)
// 3. The upstream repo
function detectOriginRepo() {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: SCRIPT_DIR,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
    // Works for https://github.com/owner/repo(.git), git@github.com:owner/repo,
    // and proxied clone URLs (e.g. Claude Code web) that end in .../owner/repo
    const match = url.match(/([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

const FEED_REPO = process.env.FB_REPO || detectOriginRepo() || 'zarazhangrui/follow-builders';
const RAW_BASE = `https://raw.githubusercontent.com/${FEED_REPO}/main`;

const FEED_X_URL = `${RAW_BASE}/feed-x.json`;
const FEED_PODCASTS_URL = `${RAW_BASE}/feed-podcasts.json`;
const FEED_BLOGS_URL = `${RAW_BASE}/feed-blogs.json`;

const PROMPTS_BASE = `${RAW_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// Load a feed: latest from GitHub first, falling back to the copy in the
// local checkout (feeds are committed to the repo daily by the GitHub Action,
// so a fresh clone always has a usable copy even without network access).
async function loadFeed(url, localFilename, errors) {
  const remote = await fetchJSON(url).catch(() => null);
  if (remote) return remote;

  const localPath = join(REPO_ROOT, localFilename);
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(await readFile(localPath, 'utf-8'));
      errors.push(`Used local copy of ${localFilename} (remote fetch failed)`);
      return local;
    } catch (err) {
      errors.push(`Could not parse local ${localFilename}: ${err.message}`);
    }
  }
  return null;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all three feeds (remote first, local checkout as fallback)
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    loadFeed(FEED_X_URL, 'feed-x.json', errors),
    loadFeed(FEED_PODCASTS_URL, 'feed-podcasts.json', errors),
    loadFeed(FEED_BLOGS_URL, 'feed-blogs.json', errors)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.errors?.length) {
    errors.push(
      ...feedX.errors.map((error) => `Tweet feed problem: ${error}`)
    );
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(
      ...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`)
    );
  }
  if (feedBlogs?.errors?.length) {
    errors.push(
      ...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`)
    );
  }

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const localPromptsDir = join(REPO_ROOT, 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`).catch(() => null);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
