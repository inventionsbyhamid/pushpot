import {
  createAuthenticationAdapter,
  RainbowKitAuthenticationProvider,
  type AuthenticationStatus,
} from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, use, useMemo, type ReactNode } from "react";
import { getAddress, isAddressEqual, type Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { useAccount } from "wagmi";
import { api, ApiError } from "./api";

const SIWE_TTL_MS = 10 * 60 * 1000;
const sessionKey = ["session"] as const;

async function fetchSession(): Promise<Address | null> {
  try {
    const { address } = await api.get<{ address: string }>("/api/me");
    return getAddress(address);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

interface Auth {
  status: AuthenticationStatus;
  /** The signed-in address, only when it matches the connected wallet. */
  address: Address | null;
}

const AuthContext = createContext<Auth>({ status: "loading", address: null });

export function useAuth(): Auth {
  return use(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const account = useAccount();
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: fetchSession,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const matches =
    !!session.data && !!account.address && isAddressEqual(session.data, account.address);
  // Not "connecting": RainbowKit keeps the connect modal open for the sign-in step only if the
  // status is already "unauthenticated" when the wallet connects.
  const status: AuthenticationStatus =
    session.isPending || account.status === "reconnecting"
      ? "loading"
      : matches
        ? "authenticated"
        : "unauthenticated";

  const adapter = useMemo(
    () =>
      createAuthenticationAdapter<string>({
        getNonce: async () => (await api.get<{ nonce: string }>("/api/auth/nonce")).nonce,
        createMessage: ({ nonce, address, chainId }) =>
          createSiweMessage({
            domain: window.location.host,
            uri: window.location.origin,
            version: "1",
            chainId,
            nonce,
            address,
            statement: "Sign in to PushPot",
            issuedAt: new Date(),
            expirationTime: new Date(Date.now() + SIWE_TTL_MS),
          }),
        verify: async ({ message, signature }) => {
          try {
            const { address } = await api.post<{ address: string }>("/api/auth/verify", {
              message,
              signature,
            });
            queryClient.setQueryData(sessionKey, getAddress(address));
            return true;
          } catch {
            return false;
          }
        },
        signOut: async () => {
          // RainbowKit calls this fire-and-forget on disconnect; the local session is
          // dropped even if the server can't be reached.
          await api.post("/api/auth/logout").catch(() => undefined);
          queryClient.setQueryData(sessionKey, null);
        },
      }),
    [queryClient],
  );

  const auth = useMemo<Auth>(
    () => ({ status, address: matches ? (session.data ?? null) : null }),
    [status, matches, session.data],
  );

  return (
    <RainbowKitAuthenticationProvider adapter={adapter} status={status}>
      <AuthContext value={auth}>{children}</AuthContext>
    </RainbowKitAuthenticationProvider>
  );
}
