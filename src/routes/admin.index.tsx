import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { BookOpen, Layers, Upload } from "lucide-react";

import { AdminForbidden } from "@/components/AdminForbidden";
import { checkAdminFn } from "@/server/admin";

/**
 * Admin hub — lists the three curation surfaces as big-link cards.
 *
 * Kept intentionally empty of data: each sub-route does its own load so
 * the hub renders instantly even when the catalog is large. The loader
 * only calls `checkAdminFn`, which is a cheap session probe.
 */
export const Route = createFileRoute("/admin/")({
  loader: async () => {
    const status = await checkAdminFn();
    if (!status.signedIn) {
      throw redirect({ to: "/sign-in" });
    }
    return { status };
  },
  component: AdminHubPage,
});

function AdminHubPage() {
  const { status } = Route.useLoaderData();
  if (!status.isAdmin) return <AdminForbidden email={status.email} />;

  return (
    <main className="page-wrap py-6 sm:py-12">
      <header className="mb-6 sm:mb-8">
        <p className="island-kicker">Admin</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)] sm:text-4xl">
          Catalog operations
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Ingest books from Hardcover, curate their editorial metadata, and
          assemble them into packs.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <HubCard
          to="/admin/ingest"
          icon={<Upload aria-hidden className="h-5 w-5" />}
          kicker="Phase 1"
          title="Ingest from Hardcover"
          description="Search, queue, and bulk-ingest books. Refreshes metadata on re-ingest; rarity is untouched."
        />
        <HubCard
          to="/admin/books"
          icon={<BookOpen aria-hidden className="h-5 w-5" />}
          kicker="Curate"
          title="Browse books"
          description="Full catalog with inline genre + mood edits and per-row pack assignment."
        />
        <HubCard
          to="/admin/packs"
          icon={<Layers aria-hidden className="h-5 w-5" />}
          kicker="Curate"
          title="Packs"
          description="Create editorial packs and manage their membership."
        />
      </div>
    </main>
  );
}

function HubCard({
  to,
  icon,
  kicker,
  title,
  description,
}: {
  to: string;
  icon: React.ReactNode;
  kicker: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="island-shell group flex flex-col gap-3 rounded-3xl p-5 text-left no-underline transition hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-2 text-[var(--lagoon)]">
        {icon}
        <span className="island-kicker">{kicker}</span>
      </div>
      <h2 className="display-title text-xl font-bold text-[var(--sea-ink)]">
        {title}
      </h2>
      <p className="text-sm text-[var(--sea-ink-soft)]">{description}</p>
      <span className="mt-auto text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--lagoon)]">
        Open →
      </span>
    </Link>
  );
}
