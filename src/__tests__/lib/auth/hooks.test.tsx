// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@test/utils";
import type * as ReactModule from "react";

import {
  signOut as authSignOut,
  signInWithGoogle,
  useAuth,
  useIsAdmin,
  useUser,
} from "@/lib/auth/hooks";

/**
 * Auth hooks test.
 *
 * The hooks facade (`src/lib/auth/hooks.ts`) is a thin translator between
 * Better Auth's `useSession()` shape and the `{ status, user, session }`
 * contract the rest of the app consumes. We mock the Better Auth client at
 * the module boundary so tests never hit a real Better Auth endpoint — the
 * facade's logic is all that matters here, not the network.
 *
 * Why mock `@/lib/auth/client` and not `better-auth/react` directly?
 * Because the facade imports the already-wired `authClient` / `useSession`
 * from our client module. Replacing that module in the Vitest loader is
 * cheaper than re-implementing `createAuthClient` semantics in the test.
 */

type MockSession = {
  data: {
    user: Record<string, unknown>;
    session: Record<string, unknown>;
  } | null;
  isPending: boolean;
};

// `vi.mock` is hoisted above `const`s, so anything the factory closes over
// has to be declared via `vi.hoisted` to avoid TDZ errors. We expose the
// mocks on a single object so tests can reach in and assert on them.
const mocks = vi.hoisted(() => {
  const sessionState: { current: MockSession } = {
    current: { data: null, isPending: true },
  };
  const listeners = new Set<() => void>();
  // Typed as a call signature rather than `ReturnType<typeof vi.fn>`: as of
  // Vitest 4 the bare `Mock` type is `Mock<Procedure | Constructable>`, a
  // union that TypeScript won't let you *call* without narrowing.
  return {
    sessionState,
    listeners,
    signOutMock: vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
    signInSocialMock: vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
  };
});

// Give the hoisted mocks their default resolutions. Mutating in place (rather
// than reassigning) keeps the reference the mock factory already closed over.
mocks.signOutMock.mockResolvedValue({ data: { success: true } });
mocks.signInSocialMock.mockResolvedValue({
  data: { url: "https://accounts.google.test/o/oauth2" },
  error: null,
});

function setSession(next: MockSession) {
  mocks.sessionState.current = next;
  for (const l of mocks.listeners) l();
}

// React-compatible `useSession` — subscribes to our in-test store so
// `act(() => setSession(...))` re-renders components using it.
function useSessionMock() {
  const { useSyncExternalStore } = require("react") as typeof ReactModule;
  return useSyncExternalStore(
    (cb: () => void) => {
      mocks.listeners.add(cb);
      return () => mocks.listeners.delete(cb);
    },
    () => mocks.sessionState.current,
    () => mocks.sessionState.current,
  );
}

vi.mock("@/lib/auth/client", () => ({
  useSession: useSessionMock,
  authClient: {
    signOut: (...args: Array<unknown>) => mocks.signOutMock(...args),
    signIn: {
      social: (...args: Array<unknown>) => mocks.signInSocialMock(...args),
    },
  },
  signIn: {
    social: (...args: Array<unknown>) => mocks.signInSocialMock(...args),
  },
  signOut: (...args: Array<unknown>) => mocks.signOutMock(...args),
}));

// `useIsAdmin` calls `checkAdminFn` from `@/server/admin`. That module
// transitively imports `@/lib/env` which dynamically imports the virtual
// `cloudflare:workers` specifier — Vitest's vite loader chokes on that
// resolve-time. We don't exercise the admin hook in these tests (it has
// its own coverage), so mock the server module at the boundary.
const checkAdminMock = vi
  .fn()
  .mockResolvedValue({ signedIn: false, isAdmin: false });
vi.mock("@/server/admin", () => ({
  checkAdminFn: (...args: Array<unknown>) => checkAdminMock(...args),
}));

const mockUser = {
  id: "user-1",
  email: "you@example.test",
  name: "You",
  displayName: "You",
  username: "you",
  avatarUrl: null,
};
const mockSession = { id: "sess-1", userId: "user-1", token: "tok" };

beforeEach(() => {
  setSession({ data: null, isPending: true });
  mocks.signOutMock.mockClear();
  mocks.signInSocialMock.mockClear();
  mocks.signInSocialMock.mockResolvedValue({
    data: { url: "https://accounts.google.test/o/oauth2" },
    error: null,
  });
});

afterEach(() => {
  setSession({ data: null, isPending: true });
});

describe("auth hooks", () => {
  it("starts in 'loading' while Better Auth's initial fetch is pending", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.status).toBe("loading");
    expect(result.current.user).toBeNull();
  });

  it("resolves to 'anonymous' when the session fetch returns no data", async () => {
    const { result } = renderHook(() => useAuth());
    act(() => setSession({ data: null, isPending: false }));
    await waitFor(() => expect(result.current.status).toBe("anonymous"));
    expect(result.current.user).toBeNull();
  });

  it("flips to 'authenticated' when the session fetch returns a user", async () => {
    const { result } = renderHook(() => useAuth());
    act(() =>
      setSession({
        data: { user: mockUser, session: mockSession },
        isPending: false,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("authenticated"));
    expect(result.current.user).toEqual(mockUser);
    expect(result.current.session).toEqual(mockSession);
  });

  it("reacts to later session changes (e.g. sign-in elsewhere)", async () => {
    const { result } = renderHook(() => useAuth());
    act(() => setSession({ data: null, isPending: false }));
    await waitFor(() => expect(result.current.status).toBe("anonymous"));

    act(() =>
      setSession({
        data: { user: mockUser, session: mockSession },
        isPending: false,
      }),
    );
    expect(result.current.status).toBe("authenticated");
    expect(result.current.user).toEqual(mockUser);
  });

  it("useUser is a thin alias for the user field", async () => {
    const { result } = renderHook(() => useUser());
    act(() =>
      setSession({
        data: { user: mockUser, session: mockSession },
        isPending: false,
      }),
    );
    await waitFor(() => expect(result.current).toEqual(mockUser));
  });

  it("signOut delegates to the Better Auth client", async () => {
    await authSignOut();
    expect(mocks.signOutMock).toHaveBeenCalledTimes(1);
  });

  it("signInWithGoogle calls signIn.social with the google provider and callback URL", async () => {
    await signInWithGoogle();
    expect(mocks.signInSocialMock).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
  });

  it("signInWithGoogle rethrows when Better Auth returns an error", async () => {
    mocks.signInSocialMock.mockResolvedValueOnce({
      data: null,
      error: { message: "oauth failed" },
    });
    await expect(signInWithGoogle()).rejects.toThrow(/oauth failed/);
  });
});

describe("useIsAdmin", () => {
  beforeEach(() => {
    checkAdminMock.mockClear();
    checkAdminMock.mockResolvedValue({ signedIn: false, isAdmin: false });
    setSession({ data: null, isPending: true });
  });

  it("returns undefined while auth is still loading", () => {
    const { result } = renderHook(() => useIsAdmin());
    expect(result.current).toBeUndefined();
    expect(checkAdminMock).not.toHaveBeenCalled();
  });

  it("returns false for anonymous users without hitting the server", async () => {
    const { result } = renderHook(() => useIsAdmin());
    act(() => setSession({ data: null, isPending: false }));
    await waitFor(() => expect(result.current).toBe(false));
    expect(checkAdminMock).not.toHaveBeenCalled();
  });

  it("calls checkAdminFn when the user is authenticated and reflects true", async () => {
    checkAdminMock.mockResolvedValueOnce({
      signedIn: true,
      isAdmin: true,
      email: "a@b.test",
    });
    const { result } = renderHook(() => useIsAdmin());
    act(() =>
      setSession({
        data: { user: mockUser, session: mockSession },
        isPending: false,
      }),
    );
    await waitFor(() => expect(result.current).toBe(true));
    expect(checkAdminMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed (returns false) if the probe rejects", async () => {
    checkAdminMock.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useIsAdmin());
    act(() =>
      setSession({
        data: { user: mockUser, session: mockSession },
        isPending: false,
      }),
    );
    await waitFor(() => expect(result.current).toBe(false));
  });
});
