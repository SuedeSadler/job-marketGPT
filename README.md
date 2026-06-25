# job-marketGPT

A live RAG-powered intelligence tool for the New Zealand job market. Ask plain english questions, get answers grounded in thousands of real, freshly-indexed job listings from Trade Me Jobs and Seek NZ.

> *"What skills are NZ employers actually asking for in IT roles right now?"*
> *"What's the going rate for nurses in Christchurch?"*
> *"Which companies are hiring the most in construction?"*

No generic advice. No hallucination. Every answer is sourced from listings scraped within the last 24 hours.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Data Pipeline                           │
│                                                                 │
│  Trade Me Jobs          Seek NZ (via Apify)                     │
│  ─────────────          ────────────────────                    │
│  Playwright scraper     Apify actor                             │
│  Railway (Node.js)      websift/seek-job-scraper                │
│  15 categories          9 industry categories                   │
│  ~1,400 listings        ~1,800 listings                         │
│         │                        │                              │
│         └──────────┬─────────────┘                              │
│                    ▼                                            │
│         OpenAI text-embedding-3-small                           │
│         (1536-dim vector per listing)                           │
│                    │                                            │
│                    ▼                                            │
│         Supabase + pgvector                                     │
│         job_listings table                                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         Query Layer                             │
│                                                                 │
│  User query                                                     │
│       │                                                         │
│       ▼                                                         │
│  /api/embed (Vercel serverless)                                 │
│  OpenAI embedding → 1536-dim vector                             │
│       │                                                         │
│       ▼                                                         │
│  Supabase RPC: match_jobs()                                     │
│  pgvector cosine similarity search                              │
│  → top 25 semantically relevant listings                        │
│       │                                                         │
│       ▼                                                         │
│  /api/query (Vercel serverless)                                 │
│  Claude Sonnet — answer grounded in retrieved listings          │
│       │                                                         │
│       ▼                                                         │
│  Answer + source attribution                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data collection

### Trade Me Jobs — Playwright scraper

Trade Me has no meaningful bot protection and renders server-side HTML, making it clean to scrape with Playwright. The scraper runs on Railway (Node.js, Dockerfile-based) and paginates through 15 job categories:

```javascript
// Each category is paginated until results dry up
const url = `https://www.trademe.co.nz/a/jobs/${category.slug}/search?page=${pageNum}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });

const jobs = await page.evaluate(() => {
  const cards = document.querySelectorAll('tm-promoted-listing-card');
  return Array.from(cards).map(card => ({
    title:    card.querySelector('.tm-promoted-listing-info__title')?.innerText,
    location: card.querySelector('.jobs-search-card-metadata__location')?.innerText,
    salary:   card.querySelector('.tm-promoted-listing-info__approximate-pay-range')?.innerText,
    snippet:  card.querySelector('.tm-promoted-listing-info__short-description')?.innerText,
    url:      card.querySelector('a.tm-promoted-listing-card__link')?.href,
  }));
});
```

The scraper exposes an HTTP server so Railway keeps the container alive and n8n can trigger scheduled runs via webhook.

### Seek NZ — Apify actor

Seek runs Radware bot protection that blocks datacenter IPs (Railway's servers get blocked immediately). The solution is Apify's managed `websift/seek-job-scraper` actor, which handles residential proxy rotation transparently.

Each run is triggered via the Apify REST API with a category-specific Seek search URL:

```javascript
const run = await fetch(`https://api.apify.com/v2/acts/websift~seek-job-scraper/runs?token=${APIFY_TOKEN}`, {
  method: 'POST',
  body: JSON.stringify({
    searchUrl: 'https://www.seek.co.nz/information-technology-jobs/in-All-New-Zealand',
    maxResults: 200,
  }),
});
```

The actor returns rich structured data per listing — full job description, bullet points, salary, work arrangement (remote/hybrid/on-site), applicant count, and classification. This is significantly more signal than Trade Me's snippet-only output, which makes Seek listings more useful for RAG retrieval.

Nine categories are scraped sequentially (IT, Healthcare, Trades, Engineering, Accounting, Construction, Hospitality, Sales, Education) at 200 listings each, totalling ~1,800 Seek listings per run.

---

## Embedding and storage

Each listing is serialised into a plain text document before embedding:

```javascript
const text = [
  `Job Title: ${job.title}`,
  `Company: ${job.company}`,
  `Location: ${job.location}`,
  `Category: ${job.category}`,
  `Salary: ${job.salary || 'Not specified'}`,
  `Work type: ${job.workType}`,
  `Work arrangement: ${job.workArrangement}`,
  `Description: ${job.bulletPoints.join('. ')}`,
  `Details: ${job.sections.slice(0, 8).join('. ')}`,
].join('\n');
```

Listings are batched in groups of 20 and sent to OpenAI's `text-embedding-3-small` model (1536 dimensions, ~$0.02/million tokens). The resulting vectors are stored alongside listing metadata in Supabase using the `pgvector` extension.

Upserts use `seek_url` as the conflict key, so re-running the scraper only adds new listings rather than duplicating existing ones.

```sql
create table job_listings (
  id          bigserial primary key,
  title       text,
  company     text,
  location    text,
  salary      text,
  category    text,
  description_snippet text,
  listing_date text,
  seek_url    text unique,
  scraped_at  timestamptz default now(),
  embedding   vector(1536)
);

create index on job_listings using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

---

## RAG query pipeline

When a user submits a question, the query runs through a three-step pipeline — all server-side via Vercel serverless functions (no API keys exposed to the browser):

**Step 1 — Embed the query** (`/api/embed`)

The user's question is embedded with the same model used to embed the listings (`text-embedding-3-small`), producing a 1536-dimensional vector.

**Step 2 — Vector search** (Supabase RPC)

A cosine similarity search retrieves the 25 most semantically relevant listings using a Postgres function:

```sql
create function match_jobs(
  query_embedding vector(1536),
  match_count     int default 20,
  filter_category text default null
)
returns table (...)
language sql stable as $$
  select *, 1 - (embedding <=> query_embedding) as similarity
  from job_listings
  where filter_category is null or category = filter_category
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

This is pure semantic search — a query like *"roles that involve Python and cloud infrastructure"* will surface relevant listings even if those exact words don't appear in the job title.

**Step 3 — Generate answer** (`/api/query`)

The retrieved listings are serialised into a context block and passed to Claude Sonnet along with the original question:

```javascript
const context = results.map(r =>
  `Title: ${r.title}
   Company: ${r.company}
   Location: ${r.location}
   Salary: ${r.salary || 'Not specified'}
   Description: ${r.description_snippet}`
).join('\n\n---\n\n');

// Claude is instructed to answer only from the provided context
// — no hallucination, no generic advice
```

Claude synthesises an answer from the retrieved listings, citing specifics (salary ranges, company names, skill patterns) rather than generating general knowledge responses.

---

## Stack

| Layer | Tech |
|---|---|
| Trade Me scraper | Playwright · Node.js · Railway |
| Seek scraper | Apify (`websift/seek-job-scraper`) |
| Embeddings | OpenAI `text-embedding-3-small` |
| Vector store | Supabase pgvector |
| LLM | Claude Sonnet (Anthropic API) |
| API proxy | Vercel serverless functions |
| Frontend | Vanilla HTML/CSS/JS |
| Scheduler | n8n cloud (webhook triggers) |

---

## Environment variables

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

Set in Vercel → Settings → Environment Variables. The Supabase anon key is safe to expose in the client.

---

## Triggering scrape runs

```bash
# Trade Me scrape
curl -X POST https://your-railway-url.up.railway.app/scrape

# Seek scrape via Apify
curl -X POST https://your-railway-url.up.railway.app/apify-scrape

# Check status
curl https://your-railway-url.up.railway.app/
```

---

Built by Nancy Qin · 2026