/**
 * Single reducer for the VS create flow.
 *
 * The page used to hold all of this state in a 2,630-line client component.
 * This hook owns the state machine so it can be unit-tested in node and the
 * step components can stay presentational.
 *
 * Transitions are pure: the reducer never touches the network or the wallet.
 * Side effects (signing, mock funding, submission) live in the page and are
 * reported back into the reducer via explicit actions.
 */

import { useCallback, useReducer } from "react";

export type CreateStep = "question" | "sides" | "resolution" | "stake" | "review";

export const CREATE_STEPS: readonly CreateStep[] = [
  "question",
  "sides",
  "resolution",
  "stake",
  "review",
] as const;

export type SideId = "yes" | "no";

export interface SideDraft {
  id: SideId;
  label: string;
  /** Percentage of the pool assigned to this side, integer 0-100. */
  odds: number;
}

export interface ResolutionSource {
  url: string;
  /** Human-readable note on how the number is read from the URL. */
  note: string;
}

export type SubmitStatus = "idle" | "signing" | "funding" | "submitting" | "success" | "error";

export interface CreateVsState {
  step: CreateStep;
  question: string;
  sides: SideDraft[];
  resolution: ResolutionSource;
  /** Stake in whole tokens; the page converts to base units at submit. */
  stake: number;
  submitStatus: SubmitStatus;
  submitError: string | null;
  /** Tx hash of the created market, set on success. */
  createdTxHash: string | null;
}

export const initialCreateVsState: CreateVsState = {
  step: "question",
  question: "",
  sides: [
    { id: "yes", label: "Yes", odds: 50 },
    { id: "no", label: "No", odds: 50 },
  ],
  resolution: { url: "", note: "" },
  stake: 0,
  submitStatus: "idle",
  submitError: null,
  createdTxHash: null,
};

export type CreateVsAction =
  | { type: "SET_STEP"; step: CreateStep }
  | { type: "NEXT_STEP" }
  | { type: "PREV_STEP" }
  | { type: "SET_QUESTION"; value: string }
  | { type: "SET_SIDE_LABEL"; id: SideId; value: string }
  | { type: "SET_SIDE_ODDIS"; id: SideId; value: number }
  | { type: "SET_RESOLUTION_URL"; value: string }
  | { type: "SET_RESOLUTION_NOTE"; value: string }
  | { type: "SET_STAKE"; value: number }
  | { type: "SUBMIT_START"; status: Exclude<SubmitStatus, "idle" | "success" | "error"> }
  | { type: "SUBMIT_SUCCESS"; txHash: string }
  | { type: "SUBMIT_ERROR"; message: string }
  | { type: "RESET" };

const STEP_INDEX: Record<CreateStep, number> = {
  question: 0,
  sides: 1,
  resolution: 2,
  stake: 3,
  review: 4,
};

function clampOdds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Setting one side's odds moves the other side to keep the pool at 100%.
 * This is the behaviour the old page had and the one users expect from a
 * two-outcome market.
 */
function setSideOdds(sides: SideDraft[], id: SideId, value: number): SideDraft[] {
  const next = clampOdds(value);
  return sides.map((side) => {
    if (side.id === id) return { ...side, odds: next };
    return { ...side, odds: 100 - next };
  });
}

export function createVsReducer(state: CreateVsState, action: CreateVsAction): CreateVsState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };

    case "NEXT_STEP": {
      const index = STEP_INDEX[state.step];
      const next = CREATE_STEPS[Math.min(index + 1, CREATE_STEPS.length - 1)];
      return { ...state, step: next };
    }

    case "PREV_STEP": {
      const index = STEP_INDEX[state.step];
      const prev = CREATE_STEPS[Math.max(index - 1, 0)];
      return { ...state, step: prev };
    }

    case "SET_QUESTION":
      return { ...state, question: action.value };

    case "SET_SIDE_LABEL":
      return {
        ...state,
        sides: state.sides.map((side) =>
          side.id === action.id ? { ...side, label: action.value } : side,
        ),
      };

    case "SET_SIDE_ODDIS":
      return { ...state, sides: setSideOdds(state.sides, action.id, action.value) };

    case "SET_RESOLUTION_URL":
      return { ...state, resolution: { ...state.resolution, url: action.value } };

    case "SET_RESOLUTION_NOTE":
      return { ...state, resolution: { ...state.resolution, note: action.value } };

    case "SET_STAKE":
      return { ...state, stake: Number.isFinite(action.value) ? Math.max(0, action.value) : 0 };

    case "SUBMIT_START":
      return { ...state, submitStatus: action.status, submitError: null };

    case "SUBMIT_SUCCESS":
      return { ...state, submitStatus: "success", createdTxHash: action.txHash, submitError: null };

    case "SUBMIT_ERROR":
      return { ...state, submitStatus: "error", submitError: action.message };

    case "RESET":
      return initialCreateVsState;

    default:
      return state;
  }
}

export interface UseCreateVsForm {
  state: CreateVsState;
  dispatch: React.Dispatch<CreateVsAction>;
  setStep: (step: CreateStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  setQuestion: (value: string) => void;
  setSideLabel: (id: SideId, value: string) => void;
  setSideOdds: (id: SideId, value: number) => void;
  setResolutionUrl: (value: string) => void;
  setResolutionNote: (value: string) => void;
  setStake: (value: number) => void;
  reset: () => void;
}

export function useCreateVsForm(initial?: Partial<CreateVsState>): UseCreateVsForm {
  const [state, dispatch] = useReducer(createVsReducer, {
    ...initialCreateVsState,
    ...initial,
  });

  const setStep = useCallback((step: CreateStep) => dispatch({ type: "SET_STEP", step }), []);
  const nextStep = useCallback(() => dispatch({ type: "NEXT_STEP" }), []);
  const prevStep = useCallback(() => dispatch({ type: "PREV_STEP" }), []);
  const setQuestion = useCallback((value: string) => dispatch({ type: "SET_QUESTION", value }), []);
  const setSideLabel = useCallback((id: SideId, value: string) =>
    dispatch({ type: "SET_SIDE_LABEL", id, value }), []);
  const setSideOdds = useCallback((id: SideId, value: number) =>
    dispatch({ type: "SET_SIDE_OdDIS", id, value }), []);
  const setResolutionUrl = useCallback((value: string) =>
    dispatch({ type: "SET_RESOLUTION_URL", value }), []);
  const setResolutionNote = useCallback((value: string) =>
    dispatch({ type: "SET_RESOLUTION_NOTE", value }), []);
  const setStake = useCallback((value: number) => dispatch({ type: "SET_STAKE", value }), []);
  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  return {
    state,
    dispatch,
    setStep,
    nextStep,
    prevStep,
    setQuestion,
    setSideLabel,
    setSideOdds,
    setResolutionUrl,
    setResolutionNote,
    setStake,
    reset,
  };
}
