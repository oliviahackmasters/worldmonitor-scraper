/**
 * WorldMonitor Scraper Service
 * ─────────────────────────────
 * Standalone Express microservice that scrapes WorldMonitor.app using
 * Playwright (headless Chromium) and caches results for the main
 * Scenario Plotter to poll.
 *
 * DEPLOYMENT: Deploy this on Railway, Render, or any VPS separately
 * from the Vercel frontend. It runs on a cron schedule and exposes a
 * simple GET /articles endpoint.
 *
 * ENV VARS:
 *   PORT          - HTTP port (default 3001)
 *   SCRAPE_INTERVAL_MINUTES - how often to re-scrape (default 30)
 *   ALLOWED_ORIGIN - CORS origin (set to your Vercel app URL)
 *   SECRET_TOKEN   - optional bearer token to protect the endpoint
 *
 * INSTALL:
 *   npm install express playwright
 *   npx playwright install chromium
 */

import express from "express";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const SCRAPE_INTERVAL_MS = (parseInt(process.env.SCRAPE_INTERVAL_MINUTES) || 30) * 60 * 1000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SECRET_TOKEN = process.env.SECRET_TOKEN || null;

// ── In-memory cache ───────────────────────────────────────────────────────────

let cache = {
  articles: [],
  lastScrapedAt: null,
  status: "pending",
  error: null
};

// ── Scraper ───────────────────────────────────────────────────────────────────

async function scrapeWorldMonitor() {
  console.log("[WorldMonitor] Starting scrape...");
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    });
    const page = await context.newPage();

    await page.goto("https://worldmonitor.app", {
      waitUntil: "networkidle",
      timeout: 30000
    });

    // Wait for article content to appear
    await page.waitForSelector("article, [class*='article'], [class*='story'], [class*='headline']", {
      timeout: 15000
    }).catch(() => {
      console.warn("[WorldMonitor] Selector wait timed out — scraping whatever is available");
    });

    const articles = await page.evaluate(() => {
      const results = [];

      // Strategy 1: semantic <article> tags
      document.querySelectorAll("article").forEach((el) => {
        const titleEl = el.querySelector("h1, h2, h3, h4, a");
        const linkEl = el.querySelector("a[href]");
        const snippetEl = el.querySelector("p");
        const timeEl = el.querySelector("time");

        const title = (titleEl?.textContent || "").trim();
        const url = linkEl?.href || "";
        const snippet = (snippetEl?.textContent || "").trim();
        const publishedAt = timeEl?.dateTime || timeEl?.textContent || "";

        if (title && title.length > 10) {
          results.push({ title, url, snippet: snippet.slice(0, 300), publishedAt });
        }
      });

      // Strategy 2: class-based fallback if articles array is empty
      if (results.length === 0) {
        const candidates = document.querySelectorAll(
          "[class*='article'], [class*='story'], [class*='headline'], [class*='card']"
        );
        candidates.forEach((el) => {
          const titleEl = el.querySelector("h1, h2, h3, h4");
          const linkEl = el.querySelector("a[href]");
          const snippetEl = el.querySelector("p");

          const title = (titleEl?.textContent || "").trim();
          const url = linkEl?.href || "";
          const snippet = (snippetEl?.textContent || "").trim();

          if (title && title.length > 10 && !results.some((r) => r.title === title)) {
            results.push({ title, url, snippet: snippet.slice(0, 300), publishedAt: "" });
          }
        });
      }

      return results.slice(0, 20);
    });

    await browser.close();

    const cleaned = articles
      .filter((a) => a.title && a.title.length > 5)
      .map((a) => ({
        source: "WorldMonitor",
        title: a.title,
        url: a.url || "https://worldmonitor.app",
        contentSnippet: a.snippet || "",
        isoDate: a.publishedAt || new Date().toISOString()
      }));

    cache = {
      articles: cleaned,
      lastScrapedAt: new Date().toISOString(),
      status: "ok",
      error: null
    };

    console.log(`[WorldMonitor] Scraped ${cleaned.length} articles successfully.`);
    return cleaned;
  } catch (error) {
    console.error("[WorldMonitor] Scrape failed:", error.message);
    if (browser) await browser.close().catch(() => {});

    cache = {
      ...cache,
      status: "error",
      error: error.message,
      lastScrapedAt: new Date().toISOString()
    };

    return [];
  }
}

// ── Scheduled scraping ────────────────────────────────────────────────────────

async function startScheduledScraping() {
  // Run immediately on startup
  await scrapeWorldMonitor();

  // Then on interval
  setInterval(async () => {
    await scrapeWorldMonitor();
  }, SCRAPE_INTERVAL_MS);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  next();
});

// Optional token auth
app.use((req, res, next) => {
  if (!SECRET_TOKEN) return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${SECRET_TOKEN}`) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// GET /articles — returns cached articles
app.get("/articles", (req, res) => {
  res.json({
    source: "WorldMonitor",
    status: cache.status,
    lastScrapedAt: cache.lastScrapedAt,
    articleCount: cache.articles.length,
    articles: cache.articles,
    error: cache.error || undefined
  });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: cache.status,
    lastScrapedAt: cache.lastScrapedAt,
    articleCount: cache.articles.length
  });
});

// POST /scrape — trigger a manual scrape
app.post("/scrape", async (req, res) => {
  res.json({ ok: true, message: "Scrape triggered" });
  await scrapeWorldMonitor(); // non-blocking response, scrape continues
});

app.listen(PORT, () => {
  console.log(`[WorldMonitor Scraper] Listening on port ${PORT}`);
  startScheduledScraping();
});
