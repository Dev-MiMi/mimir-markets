import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ROUNDING_POLICY_VERSION,
  snapshotFeePolicy,
  splitFees,
} from "../../lib/fees";
import {
  principalSafePayout,
  previewChallengerPayoutSafe,
  toPrincipalSafePreview,
} from "../../lib/payout";
import {
  feeTerms,
  GOLDEN,
  grossUnits,
  invalidFees,
  loadingFees,
  readyFees,
  unavailableFees,
} from "./payout-preview-fixtures";

const fixture = readFileSync(
  join(process.cwd(), "tests/fixtures/payout-rounding/v1.csv"),
  "utf8",
);

test("Rust and client share the same explicit policy and atomic rounding vectors", () => {
  for (const line of fixture.trim().split("\n").slice(1)) {
    const [version, principal, gross, p, o, owner, fee, net] = line.split(",").map(BigInt);
    assert.equal(Number(version), ROUNDING_POLICY_VERSION);
    const terms = feeTerms({
      platformFeeBps: Number(p),
      agentOwnerFeeBps: Number(o),
      agentOwnerRecipient: owner === 1n ? feeTerms().agentOwnerRecipient : null,
    });
    const preview = principalSafePayout({
      gross: grossUnits(principal, gross - principal),
      feeState: { status: "ready", terms },
      requiredRoundingPolicyVersion: Number(version),
    });
    const split = splitFees({
      principalUnits: principal,
      grossPayoutUnits: gross,
      snapshot: snapshotFeePolicy({ ...terms, platformRecipient: terms.platformRecipient! }),
      outcome: "challengers_win",
      requiredRoundingPolicyVersion: Number(version),
    });
    assert.equal(preview.roundingPolicyVersion, Number(version));
    assert.equal(preview.split.payoutUnits, net);
    assert.equal(preview.split.platformFeeUnits + preview.split.agentOwnerFeeUnits, fee);
    assert.deepEqual(preview.split, split);
    assert.equal(toPrincipalSafePreview(preview).roundingPolicyVersion, Number(version));
  }
});

test("the default and explicit v1 previews preserve existing payout amounts", () => {
  const args = {
    settlementMode: "pool" as const,
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees(),
  };
  const legacyCall = previewChallengerPayoutSafe(args);
  assert.deepEqual(legacyCall, previewChallengerPayoutSafe({
    ...args,
    requiredRoundingPolicyVersion: ROUNDING_POLICY_VERSION,
  }));
  assert.equal(legacyCall.roundingPolicyVersion, 1);
  assert.equal(legacyCall.netPayout, 10.99);
  assert.equal(legacyCall.totalFee, 0.01);
});

test("empty, pending and refund previews retain explicit version metadata", () => {
  for (const feeState of [readyFees(), unavailableFees, loadingFees, invalidFees]) {
    const preview = principalSafePayout({ gross: grossUnits(0n, 0n), feeState });
    assert.equal(preview.roundingPolicyVersion, 1);
    assert.equal(toPrincipalSafePreview(preview).roundingPolicyVersion, 1);
    assert.equal(preview.split.payoutUnits, 0n);
  }
  for (const outcome of ["draw", "unresolvable", "cancelled"] as const) {
    const preview = principalSafePayout({
      gross: grossUnits(20_000_000n, 0n),
      feeState: readyFees(),
      outcome,
    });
    assert.equal(preview.roundingPolicyVersion, 1);
    assert.equal(preview.split.payoutUnits, 20_000_000n);
  }
});

test("unsupported required versions fail even on zero profit or unavailable fees", () => {
  for (const version of [0, 2, 4_294_967_295, -1, 1.5, NaN, Infinity]) {
    for (const feeState of [readyFees(), unavailableFees, loadingFees, invalidFees]) {
      assert.throws(() => principalSafePayout({
        gross: grossUnits(20_000_000n, 0n),
        feeState,
        requiredRoundingPolicyVersion: version,
      }), RangeError);
    }
    assert.throws(() => splitFees({
      principalUnits: 20_000_000n,
      grossPayoutUnits: 20_000_000n,
      snapshot: snapshotFeePolicy({ ...feeTerms(), platformRecipient: "platform" }),
      outcome: "draw",
      requiredRoundingPolicyVersion: version,
    }), RangeError);
    assert.throws(() => previewChallengerPayoutSafe({
      settlementMode: "pool",
      stake: 0,
      creatorStake: 0,
      challengerPoolBefore: 0,
      requiredRoundingPolicyVersion: version,
    }), RangeError);
  }
});
