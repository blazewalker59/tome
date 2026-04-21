import { describe, expect, it, vi } from "vitest";

/**
 * Server-side session reader test.
 *
 * `getSessionUser()` is called from every protected server function, so it
 * must be rock-solid about the two extremes:
 *   1. No session cookie on the request → returns `null` (anonymous).
 *   2. A valid cookie → returns the matched Better Auth user.
 *
 * We mock both collaborators (`getAuth` from `./server`, and TanStack
 * Start's `getRequest`) because the real dependencies need a live Worker
 * request context and a real Better Auth instance. Neither is meaningful
 * in a unit test — all we're validating here is the thin translation
 * layer.
 */

const getSessionMock = vi.fn();
const requestMock = { headers: new Headers() };

vi.mock("@/lib/auth/server", () => ({
  getAuth: async () => ({ api: { getSession: getSessionMock } }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => requestMock,
}));

import { getSessionUser, requireSessionUser } from "@/lib/auth/session";

describe("getSessionUser", () => {
  it("returns null when Better Auth reports no session", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns the user when Better Auth returns a session", async () => {
    const user = { id: "u1", email: "you@example.test", username: "you" };
    getSessionMock.mockResolvedValueOnce({ user, session: { id: "s1" } });
    await expect(getSessionUser()).resolves.toEqual(user);
  });

  it("forwards the request headers verbatim to auth.api.getSession", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    await getSessionUser();
    expect(getSessionMock).toHaveBeenCalledWith({ headers: requestMock.headers });
  });
});

describe("requireSessionUser", () => {
  it("throws 'Not authenticated' when no session is present", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    await expect(requireSessionUser()).rejects.toThrow(/not authenticated/i);
  });

  it("returns the user when authenticated", async () => {
    const user = { id: "u1", username: "you" };
    getSessionMock.mockResolvedValueOnce({ user, session: { id: "s1" } });
    await expect(requireSessionUser()).resolves.toEqual(user);
  });
});
