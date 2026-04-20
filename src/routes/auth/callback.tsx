import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { getSupabase } from '@/lib/supabase/client'

export const Route = createFileRoute('/auth/callback')({
  component: AuthCallbackPage,
  // Client-only render. The server has no localStorage / no PKCE verifier,
  // so SSR-ing this page is pointless at best and can blank-screen it at
  // worst if something on the server path throws.
  ssr: false,
})

type CallbackState =
  | { kind: 'exchanging' }
  | { kind: 'success' }
  | { kind: 'error'; message: string; detail?: string }

// Hard timeout on the exchange. Without this, a stalled network request
// would leave the page spinning forever with no feedback.
const EXCHANGE_TIMEOUT_MS = 15_000

// Where we send the user after a successful sign-in.
const POST_SIGN_IN_PATH = '/'

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Module-level guard so React 18 StrictMode's double-invoked effects can't
 * fire the PKCE exchange twice. A second exchange would fail noisily (code
 * already consumed, code_verifier already cleared) even though the session
 * from the first call is already valid. We only need once-per-page-load
 * semantics; a module variable does that without a React state roundtrip.
 */
let exchangeStarted = false

/**
 * OAuth landing page. Drives the PKCE code exchange explicitly so the page
 * can await it and navigate deterministically. `detectSessionInUrl` is
 * disabled on the client so there is no race with this code path.
 *
 * Successful redirects use `window.location.replace` rather than the TanStack
 * Router `navigate` so the hard nav is immune to React StrictMode cleanup
 * racing with the async exchange — the browser wins regardless of whether
 * the component is still mounted when the promise resolves.
 */
function AuthCallbackPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<CallbackState>({ kind: 'exchanging' })

  useEffect(() => {
    if (exchangeStarted) return
    exchangeStarted = true

    ;(async () => {
      try {
        const url = new URL(window.location.href)

        const providerError =
          url.searchParams.get('error_description') ??
          url.searchParams.get('error')
        if (providerError) {
          setState({ kind: 'error', message: providerError })
          return
        }

        const code = url.searchParams.get('code')
        const supabase = getSupabase()

        if (!code) {
          // No code — maybe a stale refresh after a prior exchange. If a
          // session is already in storage we can still redirect home.
          const { data } = await withTimeout(
            supabase.auth.getSession(),
            EXCHANGE_TIMEOUT_MS,
            'getSession',
          )
          if (data.session) {
            setState({ kind: 'success' })
            window.location.replace(POST_SIGN_IN_PATH)
          } else {
            setState({
              kind: 'error',
              message: 'Missing authorization code.',
              detail: 'This page expects a ?code=... query from Google.',
            })
          }
          return
        }

        // eslint-disable-next-line no-console
        console.log('[auth/callback] exchanging code for session…')
        // eslint-disable-next-line no-console
        console.log(
          '[auth/callback] cookies on arrival:',
          document.cookie
            .split(';')
            .map((c) => c.trim().split('=')[0])
            .filter(Boolean),
        )
        const { data, error } = await withTimeout(
          supabase.auth.exchangeCodeForSession(code),
          EXCHANGE_TIMEOUT_MS,
          'exchangeCodeForSession',
        )

        if (error) {
          // eslint-disable-next-line no-console
          console.error('[auth/callback] exchange error:', error)
          setState({
            kind: 'error',
            message: error.message || 'Exchange failed',
            detail: error.name,
          })
          return
        }

        // eslint-disable-next-line no-console
        console.log(
          '[auth/callback] exchange ok, user:',
          data.session?.user?.email,
        )
        setState({ kind: 'success' })
        // Hard redirect — survives StrictMode remounts and guarantees the
        // home route boots with the fresh session.
        window.location.replace(POST_SIGN_IN_PATH)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[auth/callback] unexpected error:', err)
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Unexpected error',
          detail: err instanceof Error ? err.stack : undefined,
        })
      }
    })()
  }, [])

  // Inline style fallbacks so the page is legible even if the global
  // stylesheet hasn't hydrated yet (some SSR-off edge cases render before
  // the CSS link resolves).
  return (
    <main
      className="page-wrap flex min-h-[60vh] items-center justify-center px-4 py-10"
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2.5rem 1rem',
        color: 'var(--sea-ink, #ece4cf)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
      }}
    >
      <div
        className="w-full max-w-md text-center"
        style={{ width: '100%', maxWidth: '28rem', textAlign: 'center' }}
      >
        {state.kind === 'exchanging' && (
          <>
            <p className="island-kicker">Signing you in…</p>
            <p
              className="mt-3 text-sm text-[var(--sea-ink-soft)]"
              style={{
                marginTop: '0.75rem',
                fontSize: '0.875rem',
                opacity: 0.7,
              }}
            >
              Hang tight while we finish handshaking with Google.
            </p>
          </>
        )}

        {state.kind === 'success' && (
          <>
            <p className="island-kicker">Signed in</p>
            <p
              className="mt-3 text-sm text-[var(--sea-ink-soft)]"
              style={{
                marginTop: '0.75rem',
                fontSize: '0.875rem',
                opacity: 0.7,
              }}
            >
              Taking you home…
            </p>
          </>
        )}

        {state.kind === 'error' && (
          <div
            className="island-shell rounded-3xl p-8"
            style={{
              borderRadius: '1.5rem',
              padding: '2rem',
              border: '1px solid var(--line, rgba(255,255,255,0.12))',
              background: 'var(--surface-strong, rgba(18,28,22,0.92))',
            }}
          >
            <p className="island-kicker">Sign-in failed</p>
            <p
              role="alert"
              style={{
                marginTop: '1rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.75rem',
                fontSize: '0.75rem',
                color: 'var(--rarity-foil, #c97256)',
                border: '1px solid var(--rarity-foil, #c97256)',
                background: 'var(--rarity-foil-soft, rgba(201,114,86,0.2))',
              }}
            >
              {state.message}
            </p>
            {state.detail && (
              <p
                style={{
                  marginTop: '0.5rem',
                  fontSize: '10px',
                  opacity: 0.6,
                  wordBreak: 'break-word',
                }}
              >
                {state.detail}
              </p>
            )}
            <button
              type="button"
              onClick={() => void navigate({ to: '/sign-in', replace: true })}
              style={{
                marginTop: '1.5rem',
                width: '100%',
                minHeight: '44px',
                padding: '0.75rem 1.5rem',
                borderRadius: '9999px',
                background: 'var(--btn-primary-bg, #7bc28a)',
                color: 'var(--btn-primary-text, #0d1411)',
                fontSize: '0.875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.16em',
                fontWeight: 600,
                border: 0,
                cursor: 'pointer',
              }}
            >
              Back to sign-in
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
