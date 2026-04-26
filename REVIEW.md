# Tome — App flow & value-prop review

_Snapshot: 2026-04-25_

## What Tome is (per spec)

A **trading-card app for readers**. Read books → earn shards → rip themed
packs → collect cards → build & share your own packs. Stack: TanStack
Start + React 19 + Tailwind v4 + Drizzle/Neon + Better Auth (Google) +
Hardcover ingestion + Cloudflare Workers.

The intended flywheel is good: **the reading log is the engine, the rip
is the reward, user-built packs are the long-tail content engine.**
Everything else (decks, social feed, shards-shop) is v1.1+.

---

## What's actually built

### Core loop — implemented end-to-end

- **Sign-in** via Google OAuth, Better Auth user-create hooks derive
  username + grant 200 welcome shards (`src/lib/auth/server.ts:128`).
- **Reading log** — search local + Hardcover fallback, TBR/reading/
  finished status, start/finish grants 5/100 shards with daily/weekly
  caps and once-ever-per-book uniqueness via partial unique index
  (`src/server/reading.ts`, `src/db/schema.ts:523`).
- **Pack rip** — pick from `/rip` carousel, tear-open animation,
  weighted-rarity pulls, dupes refund flat shards, atomic transaction
  with row-locked balance (`src/components/rip/RipPackShell.tsx`,
  `src/server/collection.ts:627`).
- **Collection** at `/library/collection`, **Reading log** at
  `/library/reading`, **My packs** at `/packs`, **public profile/pack**
  at `/u/$username` and `/u/$username/$slug`, **rip a user pack** at
  `/rip/u/$username/$slug`.
- **Pack builder** — drafts, global catalog search with on-demand
  Hardcover ingest, composition validation (≥10 books, ≥3 uncommon+,
  ≥1 rare+), publish gated by 3-finished-books unlock, slug per-creator
  namespace (`src/server/user-packs.ts`, `src/lib/packs/composition.ts`).
- **Shard ledger** with cached balance, audit-grade event log, every
  change auditable.

### Visible navigation

Mobile bottom-tabs: `Home / Rip / Library`. Desktop top-nav:
`Home / Rip / Library` + account dropdown. **No discovery / community /
build entry point in primary nav** — `My packs` is buried in the account
dropdown.

### Home (`/`)

Hero → library glance (signed-in only) → 5 starter packs strip → How it
works (4 steps).

### `/rip` hub

Two sections: **Editor's picks** carousel and **Recently shared by
community** — _all placeholders, hard-coded "coming soon"_
(`src/routes/rip.index.tsx:77`).

---

## The feedback loop, as the user actually experiences it

> Sign in → 200 free shards → rip 4 starter packs in a row → collection
> has ~16 books, no reading state → ??? → log a book started (5 shards)
> → log a book finished (100 shards) → enough for 2 more rips → repeat.

**What works**: the rip-reveal moment is genuinely good (animation,
shimmer, dupe-stamp, toast). Reading-log → shards → rip is real and
atomic.

**What breaks the loop**:

1. **Welcome grant is 4 free rips.** New user blows their grant in
   60 seconds, hits the empty `/rip` "you can't afford this" gate, and
   has zero context for why the cure is "go log a book". The
   CORE_LOOP_PLAN flagged this as an open question; data now strongly
   suggests it's too many.
2. **No discovery surface for user packs.** The community carousel is
   a placeholder. So even after a user finishes the build/publish
   flow, **nobody can find their pack**. The flywheel's outer loop
   (user packs → other users rip them) is not connected.
3. **No social/return hook.** Spec calls for a follow-feed; not built.
   No notifications when somebody rips your pack. No "your pack got 5
   rips this week" email/toast. No reason to come back tomorrow once
   shards run out.
4. **Reading log isn't sticky.** No reading streak, no progress bar,
   no "5 days since you logged anything" nudge, no goal/year-target.
   The log is a transaction surface, not a habit surface.
5. **Onboarding is implicit.** The home "How it works" card is a
   4-tile explainer at the bottom of the page; there's no first-run
   tour, no "log your first book to earn 5 shards" tutorial highlight,
   no progressive disclosure. The user-built-pack flow has a 3-finished-
   books gate that nothing surfaces until the user clicks publish and
   gets rejected (`getMyPublishUnlockFn` exists but isn't shown
   proactively).
6. **No empty-state on `/rip` when broke.** Insufficient-shards is
   handled at commit time inside `RipPackShell` (`canAfford` flag), but
   there's no path forward besides "Finish a book". Nothing tells the
   user how many shards they're short or what the cheapest available
   action is.

---

## Critical gaps (in severity order)

### Severity 1 — economic / security

1. **`recordRipFn` doesn't validate that pulled book IDs are members of
   the pack.** `src/server/collection.ts:680-690` only checks that the
   `bookId`s exist in `books`. A malicious client can POST
   `{ packId: <cheap-pack>, pulledBookIds: [<5 legendaries from anywhere>] }`
   and the server will: deduct pack cost, insert those books into their
   collection, bump the pack's rip count, and award dupe refunds if
   owned. **The whole rip is computed client-side** in
   `RipPackShell.tsx:80-103` (`pullPack` runs in the browser). The
   server is a passive recorder. This needs to move server-side or,
   minimally, validate `pulledBookIds ⊆ packBooks(packId)`.

2. **`packs.rip_count_week` never decays** (`src/db/schema.ts:312`,
   comment in `src/server/collection.ts:798-802`). When the Discover
   tab ships, "trending this week" will be sort-by-all-time. Two ways
   to fix: a scheduled job that deletes rips older than 7 days from
   the count, or compute on-read with a windowed query against
   `pack_rips`.

3. **In-rip duplicate classification is subtle and probably wrong.**
   `recordRipFn` line 714-716:

   ```ts
   const duplicateBookIds = pulledBookIds.filter(
     (id, idx) => ownedSet.has(id) || newBookIds.indexOf(id) !== idx,
   );
   ```

   `newBookIds` is `pulledBookIds.filter(id => !ownedSet.has(id))` —
   different array, different indices. The
   `newBookIds.indexOf(id) !== idx` check compares an index in
   `newBookIds` to an index in `pulledBookIds`, which is meaningless.
   Worth a careful unit test with a pull like `[A, A, A]` where A is
   unowned: expected = 1 new + 2 dupes; this code may misclassify.

4. **Ripping a user's own pack is allowed**. Nothing prevents a creator
   from spending 50 shards to rip a pack they made (and earn dupe
   refunds for the books they already own). Combined with no
   per-creator self-rip filter, this is a low-effort grind.

### Severity 2 — product / loop

5. **Community/Discover surface is unimplemented.** Placeholder
   carousel on `/rip`, no `listPublicPacksFn`, no trending sort, no
   genre filter, no profile browsing entry point in nav. **This is the
   entire outer loop.**
6. **No recommendation engine for what to read next.** The library
   reading list is a passive form; a user with 20 shelved books has
   no nudge toward any one of them.
7. **No notifications / activity feed.** Nothing tells the creator
   their pack got ripped. Spec called for a feed of legendary pulls
   from people you follow — not built; follow system exists in schema
   (`follows` table) but no UI.
8. **Daily-pack timer (free pack) from the spec is not built.**
   SPEC §3 promises "1 free daily pack". Currently every rip costs
   50 shards. New users (after burning the welcome grant) have no
   daily floor to keep them returning.
9. **No book detail → reading-log integration polish.** Owning a card
   and shelving it are independent — by design — but the book detail
   page should make the cross-action obvious; verify whether tapping
   a card prompts "Add to reading list?".

### Severity 3 — onboarding & polish

10. **No first-run flow.** No tour, no "do these three things to get
    started" checklist, no completion state visible. CORE_LOOP_PLAN's
    narrative ("Sign in. See packs you could rip — can't, log a book")
    is not what the UI actually narrates.
11. **Sign-in page does an unsafe `void navigate(...)` during render**
    (`src/routes/sign-in.tsx:17`). It's a side effect inside a render
    path, which will fire repeatedly. Should be `useEffect`. Minor but
    worth fixing.
12. **No bounce-back after sign-in.** `/rip/$slug` redirects anons to
    `/sign-in`, but the sign-in page doesn't read a `redirect=` param
    and bounces home (`rip.$slug.tsx:28-30` has a TODO comment about
    this).
13. **Header shard balance is lazy-loaded only when the dropdown
    opens.** Users don't see their balance unless they click. The chip
    is the most motivating UI element — put it on the header inline
    (it's the "money" in a money-game).
14. **Username generation flow is invisible.** Better Auth `before`
    hook derives a username, but there's no profile-edit UI to change
    it later. Spec calls for username on profile.
15. **No PWA install prompt / nudge.** Manifest is wired
    (`__root.tsx:64`), iOS standalone meta is set, but nothing
    surfaces "add to home screen" — the bottom-tab UX is clearly built
    for that mode.
16. **Tests skew toward pure libs.** 15 test files, mostly `lib/*`.
    Server fns have light coverage (`reading.test.ts`,
    `catalog.test.ts`); critical paths like `recordRipFn` and
    `publishPackFn` aren't covered. The dupe-classification bug above
    would be caught by one focused test.

---

## Recommended next steps (prioritized)

### Now (1–3 days, unblocks loop integrity)

1. **Fix `recordRipFn` membership validation** — add
   `WHERE pack_id = ? AND book_id IN (...)` against `pack_books` and
   reject if count != distinct ids. Move pull weighting server-side
   later if you can; for v1, validation alone closes the exploit.
2. **Add unit tests for `recordRipFn` covering: in-rip dupes,
   owned-and-in-rip, all-new, all-dupes, empty input.** Then fix the
   misclassification.
3. **Block self-rips** (pack creator can't rip their own pack). One
   `WHERE creator_id != user.id` check in `recordRipFn`.
4. **Sign-in `redirect=` param + fix the render-time `navigate`.**

### Next (1–2 weeks, restores the outer loop)

5. **Ship a minimal Discover surface.** Even just a
   `listPublicPacksFn` ordered by `published_at desc` with pagination,
   surfaced in the existing `/rip` placeholder carousel. The schema
   has `creator_id`, `is_public`, `published_at`, `genre_tags`,
   `rip_count_week` — the data is ready.
6. **Reset `rip_count_week`** — simplest path: change
   `getRipPacksFn`/`listPublicPacksFn` to compute it on-read from
   `pack_rips` with a 7-day window, drop the denormalization. Optimize
   later if needed.
7. **Reduce welcome grant to 100 (2 rips)** and add a one-time post-
   signup banner on home: "Earned 100 shards to start. Log a book to
   keep ripping." This converts the "I'm broke" moment from a
   dead-end into a tutorial beat.
8. **Add a "Daily" rip** — one free pack per UTC day, computed from
   `pack_rips WHERE user_id=? AND ripped_at > today_start`. This
   restores SPEC's daily floor.

### Soon (2–4 weeks, makes return-rate real)

9. **Discover tab bar on `/rip`** — Featured / Discover / My Packs
   (CORE_LOOP_PLAN step 8). Schema already supports it.
10. **Pack page metrics for creators** — "X people ripped your pack"
    on `/packs/$id` and `/u/$username/$slug` (when viewed by owner).
    Use `pack_rips` aggregate. This is the cheapest possible "your
    pack got ripped" notification.
11. **First-run checklist on home** — 3 items: "Log a book you
    finished", "Rip your first pack", "Build a pack" (last one
    greyed/locked with progress 0/3). Drives feature discovery
    without a tour.
12. **Profile-edit page** — username/display-name/avatar. Currently
    un-editable after derivation.

### Later (the v1.1 backlog)

13. Follow system UI + activity feed (schema exists).
14. Pack-cost scaling by rarity ceiling.
15. Reading streaks / reading-year goals.
16. Notifications (in-app + email digest of "your pack got 5 rips
    this week").
17. Search across pack name/description.
18. Genre-tag filters on Discover.

---

## One-paragraph framing for the team

The product's spine — read → earn → rip → collect → build → share —
is built across all six verbs, but **the share→discover→rip arc is a
placeholder**, which means user-built packs go into a black hole and
the flywheel stops at the user's own collection. Fix that surface and
the welcome-grant onboarding cliff and Tome goes from "demo of a TCG-
for-readers" to "a thing somebody might come back to tomorrow."
Everything else (social feed, streaks, notifications, scaling pack
cost) is real future work but secondary to closing that one loop.
Before any of that ships, the rip endpoint needs to validate pack
membership server-side — right now the entire economy is on the honor
system.
