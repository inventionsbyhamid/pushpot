import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { Pot, PotDetail } from "./types";

export const potKeys = {
  lists: ["pots"] as const,
  mine: (viewer: string | null) => ["pots", "mine", viewer] as const,
  detail: (id: number) => ["pot", id] as const,
};

const NOT_FOUND_RETRIES = 4;

export function usePot(id: number | null) {
  return useQuery({
    queryKey: potKeys.detail(id ?? 0),
    queryFn: () => api.get<PotDetail>(`/api/pots/${id}`),
    enabled: id !== null,
    // A pot that was just created can 404 for a moment while the indexer catches up.
    retry: (failures, error) =>
      error instanceof ApiError && error.status === 404
        ? failures < NOT_FOUND_RETRIES
        : failures < 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
    refetchInterval: 60_000,
  });
}

export function useMyPots(viewer: string | null, enabled: boolean) {
  return useQuery({
    queryKey: potKeys.mine(viewer),
    queryFn: async () => (await api.get<{ pots: Pot[] }>("/api/pots?scope=mine")).pots,
    enabled,
  });
}
