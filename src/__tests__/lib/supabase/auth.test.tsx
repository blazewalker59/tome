// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, waitFor } from '@test/utils'

// We mock the Supabase client at the module boundary so we never actually
// hit the network. The auth store reads `getSupabase()` from `./client`, so
// hijacking that one export is enough.
const authChangeListeners: Array<(event: string, session: unknown) => void> = []
const getSession = vi.fn()
const onAuthStateChange = vi.fn(
  (cb: (event: string, session: unknown) => void) => {
    authChangeListeners.push(cb)
    return { data: { subscription: { unsubscribe: vi.fn() } } }
  },
)
const signOut = vi.fn().mockResolvedValue({ error: null })
const signInWithOAuth = vi.fn().mockResolvedValue({
  data: { provider: 'google', url: 'https://example.test/oauth' },
  error: null,
})

// Stub window.location.assign so signInWithGoogle's redirect step doesn't
// actually navigate the jsdom window (and crash the suite).
const assignSpy = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: () => ({
    auth: { getSession, onAuthStateChange, signOut, signInWithOAuth },
  }),
  __resetSupabaseForTests: vi.fn(),
}))

import {
  __resetAuthForTests,
  signInWithGoogle,
  signOut as authSignOut,
  useAuth,
  useUser,
} from '@/lib/supabase/auth'

const mockUser = {
  id: 'user-1',
  email: 'you@example.test',
  user_metadata: { full_name: 'You' },
}

beforeEach(() => {
  __resetAuthForTests()
  authChangeListeners.length = 0
  getSession.mockReset()
  onAuthStateChange.mockClear()
  signOut.mockClear()
  signInWithOAuth.mockClear()
  assignSpy.mockClear()
  // jsdom's location.assign is a noop by default; replace with a spy so we
  // can assert it was called (and avoid the navigation warning).
  Object.defineProperty(window, 'location', {
    writable: true,
    value: {
      ...window.location,
      assign: assignSpy,
      origin: 'http://localhost:3000',
    },
  })
})

afterEach(() => {
  __resetAuthForTests()
})

describe('auth store', () => {
  it("starts in 'loading' and resolves to 'anonymous' when no session exists", async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    const { result } = renderHook(() => useAuth())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('anonymous'))
    expect(result.current.user).toBeNull()
  })

  it("flips to 'authenticated' when getSession returns a session", async () => {
    getSession.mockResolvedValue({
      data: { session: { user: mockUser, access_token: 'tok' } },
    })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(result.current.user).toEqual(mockUser)
  })

  it('reacts to onAuthStateChange events', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    const { result } = renderHook(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    act(() => {
      // Simulate the user signing in elsewhere (e.g. OAuth callback).
      for (const cb of authChangeListeners) {
        cb('SIGNED_IN', { user: mockUser, access_token: 'tok' })
      }
    })

    expect(result.current.status).toBe('authenticated')
    expect(result.current.user).toEqual(mockUser)
  })

  it('useUser is a thin alias for the user field', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: mockUser, access_token: 'tok' } },
    })
    const { result } = renderHook(() => useUser())
    await waitFor(() => expect(result.current).toEqual(mockUser))
  })

  it('signOut delegates to the Supabase client', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    renderHook(() => useAuth())
    await authSignOut()
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('signInWithGoogle calls signInWithOAuth with the google provider and a callback URL', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    renderHook(() => useAuth())
    await signInWithGoogle()
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: expect.objectContaining({
        redirectTo: expect.stringContaining('/auth/callback'),
      }),
    })
  })
})
