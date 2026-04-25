import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";

/**
 * /library layout route.
 *
 * Hosts the two tabs — Collection (the card-grid) and Log (the
 * reading log) — under a single shared shell. The tabs used to be
 * two separate top-level routes (/collection, /reading) which
 * meant the user had to cross the main nav to move between the
 * library's card view and its reading view. Collapsing them under
 * one parent route with real nested routes gives each tab its own
 * URL (/library/collection, /library/reading) so deep-linking and
 * the browser back button still work, while the tab bar lives once
 * in this layout instead of being duplicated per child.
 *
 * The parent is auth-neutral: each child route owns its own
 * redirect to /sign-in if required. That keeps anonymous users
 * from ever hitting a tab bar for a page they can't see.
 */
export const Route = createFileRoute("/library")({
  component: LibraryLayout,
});

const TABS: ReadonlyArray<{ to: "/library/collection" | "/library/reading"; label: string }> = [
  // Order is intentional: Collection is the default landing tab
  // (it's the denser surface and what most returning users want to
  // see), with Log as the quieter companion. library.index.tsx
  // redirects bare /library here.
  { to: "/library/collection", label: "Collection" },
  { to: "/library/reading", label: "Log" },
];

function LibraryLayout() {
  // Resolve the active tab from the pathname so the indicator is
  // driven by the real URL (and therefore survives back/forward
  // navigation) rather than a local state field that could drift.
  // Prefix-match — children may append their own search params or
  // nested paths and those shouldn't desync the highlight.
  const { pathname } = useLocation();

  return (
    <main className="page-wrap pb-6 pt-4 sm:py-12">
      {/* Page title — shared across both tabs so the page identity
          ("Library") is always visible, with the tabs acting as the
          pivot between its two facets. Kept intentionally close to
          the original /collection heading to minimise visual
          churn for existing users. */}
      <h1 className="display-title mb-3 text-2xl font-bold text-[var(--sea-ink)] sm:mb-5 sm:text-4xl">
        Library
      </h1>

      {/* Tab row — reuses the canonical `.view-tabs` pill pattern
          used elsewhere for segmented controls (collection view
          switcher, reading status tabs). role=tablist / aria-
          selected keep it accessible as a tab panel pivot. */}
      <nav role="tablist" aria-label="Library tabs" className="view-tabs mb-4 flex gap-2 sm:mb-6">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.to);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              role="tab"
              aria-selected={active}
              className={`view-tab ${active ? "is-active" : ""}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <Outlet />
    </main>
  );
}
