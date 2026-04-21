// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@test/utils";

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
  data: { user: Record<string, unknown>; session: Record<string, unknown> } | null;
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
  return {
    sessionState,
    listeners,
    signOutMock: (async () => ({ data: { success: true } })) as unknown as ReturnType<
      typeof vi.fn
    >,
    signInSocialMock: (async () => ({
      data: { url: "https://accounts.google.test/o/oauth2" },
      error: null,
    })) as unknown as ReturnType<typeof vi.fn>,
  };
});

// Replace the hoisted stubs with real vi.fn()s we can assert on. Mutating
// the `mocks` object keeps the reference the mock factory already holds.
mocks.signOutMock = vi.fn().mockResolvedValue({ data: { success: true } });
mocks.signInSocialMock = vi
  .fn()
  .mockResolvedValue({ data: { url: "https://accounts.google.test/o/oauth2" }, error: null });

function setSession(next: MockSession) {
  mocks.sessionState.current = next;
  for (const l of mocks.listeners) l();
}

// React-compatible `useSession` — subscribes to our in-test store so
// `act(() => setSession(...))` re-renders components using it.
function useSessionMock() {
  const { useSyncExternalStore } = require("react") as typeof import("react");
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
    signOut: (...args: unknown[]) => mocks.signOutMock(...args),
    signIn: { social: (...args: unknown[]) => mocks.signInSocialMock(...args) },
  },
  signIn: { social: (...args: unknown[]) => mocks.signInSocialMock(...args) },
  signOut: (...args: unknown[]) => mocks.signOutMock(...args),
}));

import {
  signInWithGoogle,
  signOut as authSignOut,
  useAuth,
  useUser,
} from "@/lib/auth/hooks";

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
      setSession({ data: { user: mockUser, session: mockSession }, isPending: false }),
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
      setSession({ data: { user: mockUser, session: mockSession }, isPending: false }),
    );
    expect(result.current.status).toBe("authenticated");
    expect(result.current.user).toEqual(mockUser);
  });

  it("useUser is a thin alias for the user field", async () => {
    const { result } = renderHook(() => useUser());
    act(() =>
      setSession({ data: { user: mockUser, session: mockSession }, isPending: false }),
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
