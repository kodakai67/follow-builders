---
name: digest
description: Generate the AI Builders Digest on demand — fetches the latest feed (X/Twitter posts, podcast transcripts, blog articles from top AI builders) and remixes it into a readable digest. Use when the user asks for their AI builders digest, today's digest, or invokes /digest or /ai. No API keys, config, or npm install needed; works in ephemeral environments like Claude Code on the web.
---

# AI Builders Digest — On-Demand Run

Generate a digest of what top AI builders are saying, right now, in this session.
This skill is designed for ephemeral environments (Claude Code on the web) where
there is no persistent `~/.follow-builders` config — sensible defaults are used
and the result is delivered in-chat and as a downloadable markdown file.

## Arguments

The user may pass arguments after `/digest`:

- **Language:** `en` (default), `zh` (Chinese), or `bilingual`
  (English + Chinese interleaved paragraph by paragraph).
- Free-text preferences like "shorter" or "tweets only" — honor them.

## Step 1: Prepare the content

From the repository root, run:

```bash
node scripts/prepare-digest.js 2>/dev/null
```

Notes:
- **No `npm install` is required** — the script only uses Node built-ins.
- The script fetches the latest feeds from this repo's `main` branch on GitHub
  (it auto-detects the fork from the git origin). If the network is unavailable,
  it automatically falls back to the feed files committed in this checkout.
- The output is a single JSON blob: `config`, `podcasts`, `x`, `blogs`,
  `prompts`, `stats`, `errors`.
- Ignore the `errors` field unless there is no content at all.

If `stats.podcastEpisodes`, `stats.xBuilders`, and `stats.blogPosts` are all 0,
tell the user "No new updates from your builders today" and stop.

## Step 2: Remix

**Your ONLY job is to remix the content from the JSON.** Do NOT fetch anything
from the web, visit any URLs, or call any APIs — everything you need is in the JSON.

Follow the prompt instructions included in the JSON:
- `prompts.digest_intro` — overall structure, ordering, and formatting rules
- `prompts.summarize_tweets` — how to summarize each builder's posts
- `prompts.summarize_podcast` — how to remix podcast transcripts
- `prompts.summarize_blogs` — how to summarize blog articles
- `prompts.translate` — translation rules (only for `zh`/`bilingual`)

ABSOLUTE RULES:
- NEVER invent or fabricate content. Only use what's in the JSON.
- Every piece of content MUST include its `url` from the JSON. No URL = do not include.
- Use each builder's `bio` field for their role; do not guess job titles.
- Skip non-substantive posts (memes, engagement bait, off-topic) entirely.

## Step 3: Deliver

1. Write the digest as a markdown file named `ai-builders-digest-YYYY-MM-DD.md`
   in the scratchpad/temp directory (NOT in the repository — do not commit it).
2. Send the file to the user as a downloadable attachment if the environment
   supports it, and also show the digest in chat.

## Freshness

Feeds are regenerated daily at ~6:17 UTC by this repo's GitHub Action
(`.github/workflows/generate-feed.yml`) and committed to `main`. Because Step 1
fetches from `main` over the network, even a long-lived session gets the latest
content. Check `stats.feedGeneratedAt` in the JSON — if it is more than ~36 hours
old, mention to the user that the feed may be stale (their fork's Action may not
be running; it needs `X_BEARER_TOKEN` and `POD2TXT_API_KEY` repo secrets, or they
can sync their fork from upstream).
