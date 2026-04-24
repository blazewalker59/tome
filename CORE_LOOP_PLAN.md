# Core loop plan

Design plan for the shard economy, user-built packs, rarity semantics,
dupe handling, and the `/rip` discovery surface. Everything here is a
design decision locked in by conversation; implementation details
(types, tables, function names) are indicative, not prescriptive — we
adjust on contact with the existing code.

## The loop

> Sign in. See packs you could rip — curated drops from Tome plus
> user-built packs. Can't rip yet: shards are at zero. Log a book you
> finished last week, earn shards. Rip the curated "2024 sci-fi
> debuts" pack. Five cards reveal; two you already own get refunded
> as shards, three are new. Mark one TBR from the card. Go to
> collection, see 3/20 on the set. Build your own pack from the
> global catalog, name it, publish, send the link to a friend. She
> rips it next morning, pulls a rare from your pack. Loop.

Reading is the economy. No reading, no shards, no rips. That makes
the tracker the engine and the rip the reward.

## 1. Shard economy

### Starting numbers

| Event | Shards | Cap |
| --- | --- | --- |
| Start reading a book | 5 | 5 books/day |
| Finish a book | 100 | 3 books/week |
| Dupe in a rip | 5 per dupe | — |
| Welcome grant | 200 | one-time at signup |
| Pack cost (default) | 50 | — |

Fully-engaged user ≈ 475 shards/week ≈ 9–10 rips/week. Casual user
(3 started, 1 finished) ≈ 115 shards ≈ 2 rips. Weekly rhythm, not a
treadmill, not starvation.

### Rules

- **TBR is free.** Adding to TBR earns 0 shards. Only "start reading"
  earns — otherwise users spam TBR to farm.
- **Each book earns each transition at most once, ever.** Un-starting
  and re-starting the same book doesn't repeat the grant. Caps
  throttle first-time events.
- **Dupe refund = any status.** If the pulled book is anywhere in
  your library (TBR, reading, finished, DNF), it's a dupe. 5 shards
  flat in v1.
- **Dupes still reveal in the rip animation** with a stamp + "+5
  shards" indicator. Hiding them loses the emotional beat of the
  refund.
- **Cap resets:** daily at local midnight (UTC if tz is too much for
  v1), weekly Monday 00:00. Implemented as "count events of type X
  since threshold Y" queries, not decrementing counters.

### Everything lives in config

One `economy_config` singleton (db row or JSON file, read on boot and
cached). No hardcoded numbers in the codebase — all reads go through
a `getEconomy()` helper. Shape:

```
economy:
  welcome_grant: 200
  transitions:
    start_reading:  { shards: 5,   daily_cap: 5 }
    finish_reading: { shards: 100, weekly_cap: 3 }
  pack_cost:
    default: 50
    # future: per-rarity-ceiling overrides
  dupe_refund:
    shards_per_dupe: 5
    # shape allows Record<Rarity, number> later for tiered refunds
    # without migration
```

### Ledger, not balance

Every shard change is a row in `shard_events` (`user_id`, `delta`,
`reason`, `ref_id`, `created_at`). Balance is derived via
`SUM(delta) WHERE user_id = ?`. Caps are derived via
`COUNT(*) WHERE reason = ? AND created_at > ?`.

Reasons (enum or string):

- `welcome_grant`
- `start_reading`
- `finish_reading`
- `dupe_refund`
- `rip` (negative delta, ref = pack_id or rip_id)

This makes every change auditable, retroactive fixes trivial, and
analytics ("your best rip", "shards earned this month") free.

## 2. User-built packs

Already exists behind admin. Plan is to expose it to users with
appropriate guardrails.

### Access

- Publishing is gated by a soft unlock: must have finished N books
  (config value, start at 3). Building drafts is unrestricted; only
  `publish` is gated.
- Anyone can view a public pack via URL unauthenticated. Ripping
  requires auth — pack page shows the contents + a "sign in to rip"
  CTA for anons.

### Composition rules

A valid, publishable pack must contain:

- At least **10 books**
- At least **1 rare or above**
- At least **3 uncommon or above** (inclusive of the rare)
- Rest can be common

Publish is blocked with a clear validator message if the pack doesn't
hit these. Save-as-draft is always allowed.

Sourcing: **global catalog search.** Creators aren't limited to their
own library. This makes user packs editorial objects ("cozy fantasy
starter pack") rather than personal library exports.

### Attribution + discovery

Pack rows gain:

- `creator_id` (nullable — Tome-authored packs are null or point to
  an editorial account)
- `is_public` (bool, false for drafts)
- `published_at`
- `genre_tags` (text[] or join table; UI deferred, schema ready)
- `rip_count_week` (denormalized, refreshed by cron or on-read cache)

Every rip records `pack_id + user_id + ripped_at` so trending is
queryable.

## 3. Rarity semantics

**Rarity is a property of the book, not the pack.** Same book = same
rarity in every context.

### Computation (v1)

One-shot batch job + recompute-on-update. Rules:

- **Legendary** — has a major literary award (Booker, Pulitzer,
  Hugo, Nebula, National Book Award, etc.) OR appears in a
  hand-maintained "canon" list.
- **Foil** — top 1% by combined `rating_count × avg_rating`.
- **Rare** — next 4%.
- **Uncommon** — next 20%.
- **Common** — everything else.

Per-book rarity stored on `books.rarity`. Remove any per-pack rarity
overrides; pack composition is just a list of book refs and each
book's rarity is sourced from the book row.

### Draw weights

A rip draws 5 cards with weighted probability, not uniform. Starting
weights:

- common 60%, uncommon 25%, rare 10%, foil 4%, legendary 1%

Applied *within* what's in the pack. A pack loaded with rares still
draws 5 cards but shifts the effective distribution — creators are
rewarded for investing in better books. A pack with 9 commons and 1
legendary will almost never yield that legendary, by design.

### Why deterministic global rarity

- "I pulled a legendary from her pack" becomes a real moment because
  legendary means something universal.
- Creators can't inflate rarity by fiat. Economy stable.
- Rarity ceilings are computable at publish time → pack-cost scaling
  works.

## 4. Pack cost scaling (future-ready)

Baseline 50 shards/pack, but cost scales with the pack's rarity
ceiling (highest-tier book it contains):

- commons + uncommons only → 40
- ≥ 1 rare → 50
- ≥ 1 foil → 75
- ≥ 1 legendary → 100

Defer implementation until user packs ship; the default 50 is fine
until creators start varying pack composition.

## 5. `/rip` as hub + discovery

Three tabs at the top of the existing `/rip` screen:

- **Featured** — Tome-authored drops, hand-curated, weekly rotation.
  4–8 packs, rotating.
- **Discover** — public user packs, default sort = rip count this
  week. Search + genre-tag filter (schema ready, UI later).
- **My Packs** — packs you've built (drafts + published) + saved /
  favorited packs.

Existing drag-to-rip carousel stays as the interaction within each
tab. Tabs just swap the underlying pack list.

### Deferred

- Search over pack name/description — ship tabs first.
- Genre tag picker UI at publish — schema ready, not urgent until
  there are hundreds of packs.
- Follow-based feed — needs a follow system; separate feature.

## Sequence

Ordering reflects dependencies and risk.

1. **Ledger & balance** — `shard_events` table, `economy_config`,
   `getBalance()`, welcome grant, balance chip in nav.
2. **Wire reading events to grants** — start/finish transitions emit
   shard events with cap checks. Toast on grant.
3. **Gate ripping behind balance** — pack cost deducted, disable rip
   if insufficient, "need X more shards" messaging.
4. **Dupes → shards** — detect dupes at rip time, grant refund, stamp
   dupe cards in UI.
5. **Compute book rarity globally** — batch job + `books.rarity`
   column, remove per-pack rarity, weighted draw at rip time.
6. **Migrate admin pack builder to user-facing** — soft unlock,
   global catalog search, enforce composition rules, public URL,
   creator attribution.
7. **Pack cost scaling + rip-from-user-pack attribution** — cost
   derived from rarity ceiling, rip records pack + creator.
8. **`/rip` tabs: Featured / Discover / My Packs** — tab UI, trending
   sort on Discover, `rip_count_week` denormalization.

### Ordering note

Step 5 (global rarity) precedes step 6 (user packs) intentionally.
Locking in stable, meaningful rarity first means the "min 1 rare,
min 3 uncommon" composition rule has real teeth — creators build
against a rarity system that won't be yanked out from under them.

### Deferred to a later phase

- Tiered dupe refunds by rarity (shape in config supports it without
  migration)
- Search + genre tag filtering UI
- Creator shard cut when others rip their pack
- Follows / follow-based feed
- Year-in-review / wrapped moments
- Explore page as dedicated surface beyond Discover tab

## Open questions to revisit

- **Timezone for daily caps.** Ship UTC v1, revisit if it confuses
  users on the edges.
- **Welcome grant amount.** 200 = 4 rips. Might be too many (trivializes
  the economy in first session) or too few (user bounces after one
  rip before understanding the loop). Watch the numbers.
- **Rarity recompute cadence.** Monthly batch is probably enough;
  on-demand recompute when a book's rating count crosses a tier
  threshold is nicer but more complex. Start monthly.
- **Dupe refund at signed-out rip preview.** Viewing a pack page
  unauthed shows contents but can't compute "would this be a dupe
  for me?" — the signed-in-to-rip gate handles this naturally.
- **Moderation of user packs.** Everyone can publish post-unlock.
  First bad pack will force a report/takedown flow. Not urgent; not
  ignored.
