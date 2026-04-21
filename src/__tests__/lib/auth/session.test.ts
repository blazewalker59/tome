import { describe, expect, it, vi, afterEach } from "vitest";

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

import { getAdminEmails, getSessionUser, requireAdmin, requireSessionUser } from "@/lib/auth/session";

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

describe("getAdminEmails", () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  it("returns an empty set when ADMIN_EMAILS is unset (fail-closed)", async () => {
    expect(await getAdminEmails()).toEqual(new Set());
  });

  it("parses a comma-separated list with whitespace tolerance", async () => {
    process.env.ADMIN_EMAILS = " alice@example.com , Bob@Example.com ";
    expect(await getAdminEmails()).toEqual(
      new Set(["alice@example.com", "bob@example.com"]),
    );
  });

  it("drops empty entries (trailing/double commas)", async () => {
    process.env.ADMIN_EMAILS = "alice@example.com,, ,";
    expect(await getAdminEmails()).toEqual(new Set(["alice@example.com"]));
  });
});

describe("requireAdmin", () => {
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  it("throws 'Not authenticated' for anonymous callers", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    process.env.ADMIN_EMAILS = "alice@example.com";
    await expect(requireAdmin()).rejects.toThrow(/not authenticated/i);
  });

  it("throws 'Not authorized' for logged-in non-admins", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "bob@example.com" },
    });
    process.env.ADMIN_EMAILS = "alice@example.com";
    await expect(requireAdmin()).rejects.toThrow(/not authorized/i);
  });

  it("throws 'Not authorized' when ADMIN_EMAILS is unset (fail-closed)", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "alice@example.com" },
    });
    await expect(requireAdmin()).rejects.toThrow(/not authorized/i);
  });

  it("returns the user when their email matches (case-insensitive)", async () => {
    const user = { id: "u1", email: "Alice@Example.com" };
    getSessionMock.mockResolvedValueOnce({ user });
    process.env.ADMIN_EMAILS = "alice@example.com";
    await expect(requireAdmin()).resolves.toEqual(user);
  });

  it("throws 'Not authorized' for a session user with no email", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "u1" /* no email */ },
    });
    process.env.ADMIN_EMAILS = "alice@example.com";
    await expect(requireAdmin()).rejects.toThrow(/not authorized/i);
  });
});
