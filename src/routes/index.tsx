import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="page-wrap px-4 pb-8 pt-6 sm:pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-5 py-8 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--lagoon)_45%,transparent),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--clay)_35%,transparent),transparent_66%)]" />
        <p className="island-kicker mb-3">Tome</p>
        <h1 className="display-title mb-4 max-w-3xl text-3xl leading-[1.05] font-bold tracking-tight text-[var(--sea-ink)] sm:mb-5 sm:text-6xl sm:leading-[1.02]">
          Rip packs. Collect books. Build decks.
        </h1>
        <p className="mb-6 max-w-2xl text-sm text-[var(--sea-ink-soft)] sm:mb-8 sm:text-lg">
          Tome turns your reading life into a trading-card collection. Open curated packs, discover
          books across every genre, and shape decks worth sharing.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Link to="/rip" className="btn-primary rounded-full px-5 text-sm">
            Rip a pack
          </Link>
          <Link to="/collection" className="btn-secondary rounded-full px-5 text-sm">
            View collection
          </Link>
        </div>
      </section>
    </main>
  );
}
