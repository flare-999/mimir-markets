import { test } from "node:test";
import assert from "node:assert";

import {
  createVsReducer,
  initialCreateVsState,
  type CreateVsState,
} from "../../hooks/useCreateVsForm";

function state(overrides: Partial<CreateVsState> = {}): CreateVsState {
  return { ...initialCreateVsState, ...overrides };
}

test("SET_STEP moves to the requested step", () => {
  const next = createVsReducer(state(), { type: "SET_STEP", step: "stake" });
  assert.equal(next.step, "stake");
});

test("NEXT_STEP advances one step and clamps at review", () => {
  const a = createVsReducer(state(), { type: "NEXT_STEP" });
  assert.equal(a.step, "sides");
  const b = createVsReducer(a, { type: "NEXT_STEP" });
  assert.equal(b.step, "resolution");
  const c = createVsReducer(b, { type: "NEXT_STEP" });
  assert.equal(c.step, "stake");
  const d = createVsReducer(c, { type: "NEXT_STEP" });
  assert.equal(d.step, "review");
  const e = createVsReducer(d, { type: "NEXT_STEP" });
  assert.equal(e.step, "review", "clamps at the last step");
});

test("PREV_STEP goes back one step and clamps at question", () => {
  const a = createVsReducer(state({ step: "stake" }), { type: "PREV_STEP" });
  assert.equal(a.step, "resolution");
  const b = createVsReducer(state(), { type: "PREV_STEP" });
  assert.equal(b.step, "question", "clamps at the first step");
});

test("SET_QUESTION updates the question without touching other fields", () => {
  const next = createVsReducer(state(), { type: "SET_QUESTION", value: "Will it rain?" });
  assert.equal(next.question, "Will it rain?");
  assert.equal(next.step, initialCreateVsState.step);
  assert.deepEqual(next.sides, initialCreateVsState.sides);
});

test("SET_SIDE_LABEL only updates the matching side", () => {
  const next = createVsReducer(state(), { type: "SET_SIDE_LABEL", id: "yes", value: "Yep" });
  const yes = next.sides.find((side) => side.id === "yes")!;
  const no = next.sides.find((side) => side.id === "no")!;
  assert.equal(yes.label, "Yep");
  assert.equal(no.label, "No");
});

test("SET_SIDE_ODDIS keeps the pool at 100%", () => {
  const next = createVsReducer(state(), { type: "SET_SIDE_ODDIS", id: "yes", value: 70 });
  const yes = next.sides.find((side) => side.id === "yes")!;
  const no = next.sides.find((side) => side.id === "no")!;
  assert.equal(yes.odds, 70);
  assert.equal(no.odds, 30);
  assert.equal(yes.odds + no.odds, 100);
});

test("SET_SIDE_ODDIS clamps to 0-100 and rounds", () => {
  const high = createVsReducer(state(), { type: "SET_SIDE_ODDIS", id: "yes", value: 150 });
  assert.equal(high.sides.find((side) => side.id === "yes")!.odds, 100);
  assert.equal(high.sides.find((side) => side.id === "no")!.odds, 0);

  const low = createVsReducer(state(), { type: "SET_SIDE_ODDIS", id: "no", value: -20 });
  assert.equal(low.sides.find((side) => side.id === "no")!.odds, 0);
  assert.equal(low.sides.find((side) => side.id === "yes")!.odds, 100);

  const rounded = createVsReducer(state(), { type: "SET_SIDE_ODDIS", id: "yes", value: 33.6 });
  assert.equal(rounded.sides.find((side) => side.id === "yes")!.odds, 34);
  assert.equal(rounded.sides.find((side) => side.id === "no")!.odds, 66);
});

test("SET_RESOLUTION_URL and NOTE update only their field", () => {
  const a = createVsReducer(state(), {
    type: "SET_RESOLUTION_URL",
    value: "https://example.org/data.json",
  });
  assert.equal(a.resolution.url, "https://example.org/data.json");
  assert.equal(a.resolution.note, "");

  const b = createVsReducer(a, { type: "SET_RESOLUTION_NOTE", value: "Read `.price` as USD" });
  assert.equal(b.resolution.url, a.resolution.url);
  assert.equal(b.resolution.note, "Read `.price` as USD");
});

test("SET_STAKE clamps negative and NaN to zero", () => {
  const a = createVsReducer(state(), { type: "SET_STAKE", value: -5 });
  assert.equal(a.stake, 0);
  const b = createVsReducer(state(), { type: "SET_STAKE", value: Number.NaN });
  assert.equal(b.stake, 0);
  const c = createVsReducer(state(), { type: "SET_STAKE", value: 12.5 });
  assert.equal(c.stake, 12.5);
});

test("SUBMIT lifecycle transitions set and clear errors", () => {
  const signing = createVsReducer(state(), { type: "SUBMIT_START", status: "signing" });
  assert.equal(signing.submitStatus, "signing");
  assert.equal(signing.submitError, null);

  const funding = createVsReducer(signing, { type: "SUBMIT_START", status: "funding" });
  assert.equal(funding.submitStatus, "funding");

  const error = createVsReducer(funding, { type: "SUBMIT_ERROR", message: "user rejected" });
  assert.equal(error.submitStatus, "error");
  assert.equal(error.submitError, "user rejected");

  const success = createVsReducer(error, { type: "SUBMIT_SUCCESS", txHash: "0xabc" });
  assert.equal(success.submitStatus, "success");
  assert.equal(success.createdTxHash, "0xabc");
  assert.equal(success.submitError, null);
});

test("RESET returns to the initial state", () => {
  const dirty = state({
    step: "review",
    question: "q?",
    stake: 99,
    submitStatus: "error",
    submitError: "boom",
  });
  const next = createVsReducer(dirty, { type: "RESET" });
  assert.deepEqual(next, initialCreateVsState);
});
