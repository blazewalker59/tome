export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-20 hidden border-t border-[var(--line)] px-4 pb-14 pt-10 text-[var(--sea-ink-soft)] sm:block">
      <div className="page-wrap flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
        <p className="m-0 text-sm">&copy; {year} Tome.</p>
        <p className="island-kicker m-0">Read. Collect. Share.</p>
      </div>
    </footer>
  );
}
