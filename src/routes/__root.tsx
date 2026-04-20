import { HeadContent, Link, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import BottomTabs from "../components/BottomTabs";
import Footer from "../components/Footer";
import Header from "../components/Header";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      {
        title: "Tome — Read. Collect. Share.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="island-shell w-full max-w-md rounded-3xl p-8 text-center">
        <p className="island-kicker">404 · off the map</p>
        <h1 className="display-title mt-2 text-3xl font-bold text-[var(--sea-ink)]">
          This page isn&rsquo;t in the library
        </h1>
        <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
          The URL you followed doesn&rsquo;t match any route. Head back home or rip a pack.
        </p>
        <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Link
            to="/"
            className="btn-primary w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
          >
            Home
          </Link>
          <Link
            to="/rip"
            className="btn-secondary w-full rounded-full px-6 py-3 text-sm uppercase tracking-[0.16em] sm:w-auto"
          >
            Rip a pack
          </Link>
        </div>
      </div>
    </main>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-[color:var(--lagoon)]/30">
        <Header />
        {children}
        <Footer />
        <BottomTabs />
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
