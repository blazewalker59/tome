# Tome — Product Specification (v1)

> A trading-card app for readers. Rip themed packs, discover books, build decks to share.

This document is the source of truth for v1 scope. Anything not described here is **out of scope** for v1.

---

## 1. Identity & Core Loop

**Tagline:** _Books, but trading cards._

**Day-to-day loop (game-first):**

1. **Rip** a themed pack (e.g. "Booker Shortlist 2024", "Cozy Sci-Fi", "Books About Grief") → 5 random cards.
2. **Collect** them into your library.
3. **Read** the books. Logging is optional but unlocks bonuses.
4. **Build** decks from cards you own (themed, recommendation, "if you liked X").
5. **Share** decks via public URL. Other users can rip your deck _as a pack_.

The flywheel: editorial packs seed the system; user decks become future packs.

---

## 2. The Card

A card is a **shared object** — the same book looks identical in every user's collection. Personal data (rating, notes, status) is a separate layer rendered on the card back.

### Card front

- Cover art (Hardcover CDN, cached locally)
- Title
- Author(s)
- **Genre** label — open-ended kebab-case string (e.g. `science-fiction`, `fantasy`, `biography`, `memoir`, `historical-fiction`, `poetry`, `graphic-novel`). Curated editorially per book.
- **Rarity** gem — one of: `common`, `uncommon`, `rare`, `foil`, `legendary`
- Up to **3 mood tags** (e.g. `slow-burn`, `cozy`, `dense`, `escapist`, `literary`)
- Page count

### Card back

- Description (truncated)
- Your status: `unread` | `reading` | `read`
- Your rating (1–5)
- Your private note
- Date acquired
- "Found in pack: …"

### Rarity assignment

- **Popularity-inverse**, computed from Hardcover ratings count.
- Bucketed globally (same rarity for every user):
  - `common` — top 20% most-rated
  - `uncommon` — next 30%
  - `rare` — next 30%
  - `foil` — next 15%
  - `legendary` — bottom 5%
- Recomputed on a schedule (cron job, daily).

### Genre assignment

Derived from Hardcover taxonomy/genres at ingestion time as an open-ended kebab-case string (e.g. `science-fiction`, `fantasy`, `biography`, `historical-fiction`, `memoir`, `poetry`, `graphic-novel`). Defaults to `literary-fiction` if ambiguous.

### Mood tags

- Curated controlled vocabulary (~20 tags).
- Assigned editorially per book (during pack curation) for v1.
- Future: ML-derived from reviews/descriptions.

---

## 3. Packs

A **pack** is a curated set of books. Ripping a pack pulls **5 cards** from its pool.

### Pack types (v1)

1. **Editorial pack** — curated by us; seeds the catalog. ~10 at launch.
2. **Deck-as-pack** — any user deck with ≥5 cards becomes ripable.

### Rip mechanics

- Pull 5 cards from the pack pool, weighted toward inverse popularity (rare books surface more than they would uniformly).
- Duplicates are **allowed**. A duplicate yields **shards** instead of a new card (see §5).
- Animation: cards reveal one by one, rarity gem glow scales with tier.

### Pack acquisition

- **1 free daily pack** (resets at user's local midnight).
- **Bonus packs** earned by:
  - Logging a finished read: +1 pack
  - Completing a deck (publishing one with ≥5 cards): +1 pack
- No purchase, no monetization in v1.

---

## 4. Decks

A **deck** is a user-curated subset of cards from their collection.

- Min size to be **ripable**: 5 cards
- Max size: 60 cards (TCG convention)
- Fields: name, description, cover-card (one of its cards), visibility (`public` | `unlisted` | `private`)
- Public decks have a stable share URL: `/d/:slug`
- A public deck appears as a ripable "pack" to other users.

---

## 5. Shards (currency)

- Earned when ripping duplicates: rarity-tier yields (common 1, uncommon 2, rare 5, foil 10, legendary 25).
- Spent in the **shard shop**: pick a specific card from any pack you've previously opened.
  - Cost = `2 × tier yield` (so a legendary = 50 shards).
- No shards-for-cash. Never.

---

## 6. Social (v1)

- **Auth:** Better Auth with Google OAuth.
- **Profile:** username, avatar, joined date, public collection count, public deck count.
- **Following:** users can follow other users.
- **Feed:** chronological feed of (a) decks published by people you follow, (b) `legendary` pulls from people you follow.
- **No comments, no likes, no DMs in v1.** Friction-free social, no moderation surface.

---

## 7. Out of scope for v1

These exist as future work, explicitly **not** in v1:

- Mobile apps (web is responsive; native comes later)
- ISBN barcode scanning
- Algorithmic recommendation packs
- Foil-upgrade-on-duplicate mechanic
- Shard _shop_ UI (shards accumulate but spending is v1.1)
- Comments, likes, reactions
- Trading cards with other users
- Monetization
- Reading statistics / year-in-review

---

## 8. Tech Stack

| Concern      | Choice                                      |
| ------------ | ------------------------------------------- |
| Toolchain    | Vite+ (`vp` CLI)                            |
| Framework    | TanStack Start (Vite + Router + server fns) |
| UI           | React 19 + Tailwind v4                      |
| Components   | shadcn/ui (manual install)                  |
| Animation    | Framer Motion (pack-rip reveal)             |
| DB           | Neon Postgres                               |
| Auth         | Better Auth (Google OAuth)                  |
| ORM          | Drizzle                                     |
| Books data   | Hardcover GraphQL API (cached in our DB)    |
| Client cache | TanStack Query                              |
| Tests        | Vitest (via `vp test`) + MSW                |
| Lint/Format  | Oxlint + Oxfmt (via `vp check`)             |
| Deploy       | Vercel or Netlify (via Nitro preset)        |

---

## 9. Build Order (MVP slice)

1. Scaffold + toolchain proof (`vp dev`, `vp test` working)
2. Drizzle schema + Neon migrations
3. Hardcover ingestion script (one-shot, populates `books` from a list of IDs)
4. Seed 3 editorial packs manually
5. Auth (Better Auth + Google OAuth)
6. Pack-rip flow with reveal animation
7. Collection view (filter by genre/rarity/mood)
8. Deck builder (drag from collection → deck)
9. Public deck page + "rip this deck" button
10. Daily pack timer + read-logging bonus

Anything beyond step 10 is v1.1.

---

## 10. Open questions (to revisit before launch)

- **Hardcover ToS:** confirm cover image redistribution + display attribution requirements before public launch.
- **Rarity recomputation cadence:** daily is the default; may need to be weekly to avoid card-rarity churn confusing users.
- **Deck-as-pack abuse:** what stops a user from making 1000 decks of the same 5 cards to game pack-bonus economy? Likely rate-limit deck-publishing bonuses (max 1/day).
- **Cover art licensing fallback:** if Hardcover doesn't have a cover, do we show a generated card or hide the book?
