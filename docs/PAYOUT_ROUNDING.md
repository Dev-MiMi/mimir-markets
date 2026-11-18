# Payout rounding policy

`mimir-market` supports **rounding policy version 1**, exposed as
`ROUNDING_POLICY_VERSION` in Rust and `lib/fees.ts`. All amounts in contract
previews are integer atomic USDC (7 decimals). XLM is only for fees and reserve.
The version describes arithmetic, independently of a claim's snapshotted fee
rates. No new configuration value or persisted claim field is needed.

Policy v1 preserves the existing settlement rules:

- Fixed-odds payouts and pool shares use checked integer multiplication and
  truncating division. For valid nonnegative amounts this rounds down.
- Fees apply only to profit. Each recipient's fee leg truncates independently;
  a missing recipient is not charged. The fee remainder stays with the participant.
- The final challenger to pull receives the remaining claim escrow, including
  pool-share dust. Draws and unresolvable outcomes return principal without fees.

## Contract and client interfaces

The existing `quote_challenger_payout(claim_id, challenger)` entry point and
`PayoutQuote { gross, fee, net, claimed }` remain unchanged.

Use `quote_payout_with_policy(claim_id, challenger, required_policy_version)`
for an explicit version. It returns:

```text
PayoutPreview {
  rounding_policy_version: 1,
  payout: { gross: 20002013, fee: 200, net: 20001813, claimed: false }
}
```

The example uses 20,000,000 atomic USDC principal and 2,013 profit at 700/300
fee bps: 140 + 60 = 200 fees. Before this change, only the inner payout fields
were available. Requiring version 0, 2, or any other unsupported u32 returns
`UnsupportedRoundingPolicyVersion` (48) before reading claim state. Zero is not
a wildcard. A supported version with a missing claim still returns
`ClaimNotFound`. Empty, unresolved, creator-win and already-claimed previews
carry version 1, preserving the legacy quote's zero amounts and claimed marker.

The versioned endpoint delegates to the legacy preview and its settlement
arithmetic. It does not accrue fees, move tokens or alter settlement state.
Like existing reads, it may extend storage TTL. Preview by simulation only;
it needs no signer or live publishing. A quote reflects the current claimant
order; another participant pulling first can change the final-claimant dust.

After regenerating bindings from the local release Wasm, clients can simulate
`quote_payout_with_policy` with `required_policy_version: 1`. Verify the returned
`rounding_policy_version` before rendering the inner payout. The existing
`lib/contract.ts::quoteChallengerPayout` wrapper stays unchanged for existing
deployments. The new endpoint requires a contract build with this interface;
do not silently fall back to an unversioned quote when an explicit policy is
required.

The local fee-aware helpers `principalSafePayout` and
`previewChallengerPayoutSafe` accept optional `requiredRoundingPolicyVersion`
and report `roundingPolicyVersion`. Omission retains v1 behavior; unsupported
versions throw `RangeError` even when fees are unavailable or profit is zero.
`splitFees` supports the same optional requirement. Pure client metadata reports
the local arithmetic policy, not proof of a deployed contract's version.

## Verification

Rust and Node tests read the same synthetic expected amounts from
`tests/fixtures/payout-rounding/v1.csv`. They cover independent fee truncation,
zero and one-unit profit, missing recipients, unsupported versions, and legacy
amount compatibility. Contract tests additionally cover preview/pull parity,
unchanged settlement balances and the final claimant's one-unit dust.

```bash
cd contracts-soroban
cargo test -p mimir-market rounding_policy
cargo test -p mimir-market a_winner_keeps_the_rounding_remainder_end_to_end
cargo test
cargo build --target wasm32v1-none --release
```

From the repository root:

```bash
node --import tsx --test tests/node/payout-rounding-policy.test.ts tests/node/payout-preview.test.ts tests/node/fees.test.ts tests/node/pool-payout.test.ts tests/node/contract-errors-doc.test.ts
```

Regenerate bindings from the local release Wasm using the pinned CLI (see
[contract toolchains](CONTRACT_TOOLCHAINS.md)); verify binding drift before merge.
No deployment, credentials or funded state change is needed for these checks.

```bash
npx --yes @stellar/stellar-cli@22.8.1 contract bindings typescript --wasm contracts-soroban/target/wasm32v1-none/release/mimir_market.wasm --output-dir sdk/contracts/mimir-market --overwrite
```
