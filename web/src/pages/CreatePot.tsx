import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAccount, useReadContract } from "wagmi";
import { Button } from "../components/Button";
import { ChipGroup } from "../components/ChipGroup";
import { FeeNote } from "../components/FeeNote";
import { TxSheet } from "../components/TxSheet";
import { CreateSummary } from "../features/create/CreateSummary";
import { MemberStepper } from "../features/create/MemberStepper";
import {
  byteLength,
  defaultStake,
  MAX_REPS,
  MAX_TITLE_BYTES,
  plans,
  repOptions,
  resolveStart,
  stakeOptions,
  startBounds,
  startError,
  type PlanId,
  type StartId,
} from "../features/create/options";
import { useNow } from "../hooks/useNow";
import { useTxFlow } from "../hooks/useTxFlow";
import { pushPotAbi } from "../lib/abi";
import { chain, pushPotAddress } from "../lib/config";
import { formatUsdc } from "../lib/format";
import { potKeys } from "../lib/queries";
import { createPot } from "../lib/stake";
import { toast } from "../lib/toast";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const inputClass =
  "min-h-12 w-full rounded-[0.625rem] border border-line bg-panel px-3 text-lg text-chalk placeholder:text-mute/70 focus:border-volt focus:outline-none";

export default function CreatePot() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const now = useNow(15_000);
  const flow = useTxFlow();

  const [title, setTitle] = useState("");
  const [repsChoice, setRepsChoice] = useState<number | "custom">(20);
  const [customReps, setCustomReps] = useState("");
  const [planId, setPlanId] = useState<PlanId>("7d");
  const [stake, setStake] = useState(defaultStake);
  const [startId, setStartId] = useState<StartId>("tomorrow");
  const [customStart, setCustomStart] = useState("");
  const [maxMembers, setMaxMembers] = useState(10);
  const [showErrors, setShowErrors] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const maxStake = useReadContract({
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "maxStake",
  });
  // New pots lock in the contract's current fee.
  const feeBps = useReadContract({
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "feeBps",
  });

  const plan = plans[planId];
  const periodWord = planId === "sprint" ? "round" : "day";
  const trimmedTitle = title.trim();
  const titleBytes = byteLength(trimmedTitle);
  const reps = repsChoice === "custom" ? Number(customReps) : repsChoice;
  const startsAt = resolveStart(startId, customStart, now);

  const errors = {
    title:
      titleBytes === 0
        ? "Give your pot a name."
        : titleBytes > MAX_TITLE_BYTES
          ? `Keep the name to ${MAX_TITLE_BYTES} characters. Emoji count as several.`
          : null,
    reps:
      Number.isInteger(reps) && reps >= 1 && reps <= MAX_REPS
        ? null
        : `Pick a whole number from 1 to ${MAX_REPS}.`,
    stake:
      maxStake.data !== undefined && stake > maxStake.data
        ? `The most anyone can stake is ${formatUsdc(maxStake.data)}.`
        : null,
    start: startError(startsAt, now),
  };
  const valid = Object.values(errors).every((e) => e === null);

  const review = () => {
    setShowErrors(true);
    if (!valid) {
      requestAnimationFrame(() =>
        document
          .querySelector("[data-field-error]")
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      return;
    }
    if (!isConnected) {
      openConnectModal?.();
      return;
    }
    flow.reset();
    setSheetOpen(true);
  };

  const confirm = async () => {
    const shownFee = feeBps.data;
    if (shownFee === undefined) return;
    const at = resolveStart(startId, customStart, Date.now());
    if (at === null || startError(at, Date.now())) {
      setSheetOpen(false);
      setShowErrors(true);
      return;
    }
    const result = await flow.run((report) =>
      createPot(
        {
          title: trimmedTitle,
          stake,
          repsPerPeriod: reps,
          periods: plan.periods,
          periodSeconds: plan.periodSeconds,
          startTime: BigInt(Math.floor(at / 1000)),
          maxMembers,
        },
        shownFee,
        report,
      ),
    );
    if (!result) return;
    void queryClient.invalidateQueries({ queryKey: potKeys.lists });
    toast(`Pot created on Arc in ${(result.confirmMs / 1000).toFixed(1)}s`, "success");
    navigate(`/p/${result.potId}`);
  };

  const shown = (error: string | null) => (showErrors ? error : null);

  return (
    <div className="pb-28">
      <h1 className="pt-6 font-display text-5xl leading-none font-black">Create a pot</h1>
      <p className="mt-2 text-mute">
        Set the rules, stake first, then send the link to your friends.
      </p>

      <form
        className="mt-8 space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <label htmlFor="title" className="font-semibold">
              Name
            </label>
            <span
              className={`text-sm tabular-nums ${titleBytes > MAX_TITLE_BYTES ? "text-flare" : "text-mute"}`}
            >
              {titleBytes}/{MAX_TITLE_BYTES}
            </span>
          </div>
          <input
            id="title"
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Morning crew"
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={!!shown(errors.title)}
          />
          <FieldError message={shown(errors.title)} />
        </div>

        <ChipGroup
          legend={`Pushups each ${periodWord}`}
          value={repsChoice}
          onChange={setRepsChoice}
          options={[
            ...repOptions.map((n) => ({ value: n, label: n })),
            { value: "custom" as const, label: "Other" },
          ]}
        >
          {repsChoice === "custom" && (
            <input
              aria-label={`Pushups each ${periodWord}`}
              className={`${inputClass} mt-2`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_REPS}
              value={customReps}
              onChange={(e) => setCustomReps(e.target.value)}
              placeholder="1 to 1000"
              autoFocus
            />
          )}
          <FieldError message={shown(errors.reps)} />
        </ChipGroup>

        <ChipGroup
          legend="How long"
          value={planId}
          onChange={setPlanId}
          options={[
            { value: "3d", label: "3", hint: "days" },
            { value: "7d", label: "7", hint: "days" },
            { value: "14d", label: "14", hint: "days" },
            { value: "sprint", label: "Sprint", hint: "3 × 10 min" },
          ]}
        />

        <ChipGroup
          legend="Stake per player"
          value={stake}
          onChange={setStake}
          options={stakeOptions.map((option) => ({
            value: option.value,
            label: option.usdc,
            hint: "USDC",
            disabled: maxStake.data !== undefined && option.value > maxStake.data,
          }))}
        >
          <FieldError message={errors.stake} />
        </ChipGroup>

        <ChipGroup
          legend="Starts"
          columns={3}
          value={startId}
          onChange={setStartId}
          options={[
            { value: "soon", label: "15 min", hint: "from now" },
            {
              value: "tomorrow",
              label: "Tomorrow",
              hint: timeFormat.format(resolveStart("tomorrow", "", now) ?? now),
            },
            { value: "custom", label: "Custom", hint: "date & time" },
          ]}
        >
          {startId === "custom" && (
            <input
              aria-label="Start date and time"
              type="datetime-local"
              className={`${inputClass} mt-2 [color-scheme:dark]`}
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              {...startBounds(now)}
            />
          )}
          <FieldError message={shown(errors.start)} />
        </ChipGroup>

        <MemberStepper value={maxMembers} onChange={setMaxMembers} />

        <CreateSummary
          title={trimmedTitle}
          reps={errors.reps ? null : reps}
          periods={plan.periods}
          periodSeconds={plan.periodSeconds}
          stake={stake}
          startsAt={errors.start ? null : startsAt}
          maxMembers={maxMembers}
          feeBps={feeBps.data}
          now={now}
        />

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/95 px-4 pt-3 pb-safe backdrop-blur-md">
          <div className="mx-auto max-w-md">
            <Button type="submit" className="min-h-14 w-full text-2xl">
              Create and stake {formatUsdc(stake)}
            </Button>
          </div>
        </div>
      </form>

      <TxSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Create pot"
        // Held back until the fee is known, so nobody signs without seeing it.
        amount={feeBps.data === undefined ? undefined : stake}
        amountLabel="You stake"
        pays
        confirmLabel="Sign and create"
        flow={flow.state}
        onConfirm={confirm}
        amountError={
          feeBps.isError
            ? "Couldn't read the platform fee from Arc. Close and try again."
            : undefined
        }
      >
        <div className="space-y-2">
          <FeeNote feeBps={feeBps.data} />
          <p className="text-sm text-mute">
            You'll sign a permit that lets the PushPot contract take exactly this amount, then
            confirm one transaction.
          </p>
        </div>
      </TxSheet>
    </div>
  );
}

function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" data-field-error className="mt-2 text-sm text-flare">
      {message}
    </p>
  );
}
