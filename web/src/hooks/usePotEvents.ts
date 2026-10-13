import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { shortAddress } from "../lib/format";
import { sameAddress } from "../lib/pot";
import { potKeys } from "../lib/queries";
import { toast } from "../lib/toast";
import type { PotEvent, PotEventKind } from "../lib/types";

const kinds: PotEventKind[] = ["joined", "left", "checked_in", "claimed"];
const MAX_ACTIVITY = 20;

export interface PotActivity {
  event: PotEvent;
  receivedAt: number;
}

function announce(event: PotEvent, viewer: Address | undefined): string {
  const you = sameAddress(event.address, viewer);
  const who = you ? "You" : shortAddress(event.address);
  switch (event.kind) {
    case "joined":
      return you ? "You're in" : `${who} joined the pot`;
    case "left":
      return `${who} left the pot`;
    case "checked_in":
      return `${who} just did ${event.reps ?? "their"} pushups 💪`;
    case "claimed":
      return `${who} claimed their payout`;
  }
}

/** Subscribes to a pot's live events, refreshing the pot and returning recent activity. */
export function usePotEvents(potId: number | null, viewer: Address | undefined): PotActivity[] {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState<PotActivity[]>([]);
  const viewerRef = useRef(viewer);
  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  useEffect(() => {
    if (potId === null) return;
    const source = new EventSource(`/api/pots/${potId}/events`);
    const refresh = () => queryClient.invalidateQueries({ queryKey: potKeys.detail(potId) });

    let opened = false;
    // After a dropped connection, refetch to pick up anything missed while away.
    source.onopen = () => {
      if (opened) void refresh();
      opened = true;
    };

    const onEvent = (message: MessageEvent<string>) => {
      let event: PotEvent;
      try {
        event = JSON.parse(message.data) as PotEvent;
      } catch {
        return;
      }
      void refresh();
      setActivity((list) => [{ event, receivedAt: Date.now() }, ...list].slice(0, MAX_ACTIVITY));
      toast(announce(event, viewerRef.current), event.kind === "checked_in" ? "success" : "info");
    };

    for (const kind of kinds) source.addEventListener(kind, onEvent);
    return () => source.close();
  }, [potId, queryClient]);

  return activity;
}
