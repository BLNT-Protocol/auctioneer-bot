import { Auction, FixedMath, PoolOracle } from '@blend-capital/blend-sdk';
import { Asset, Contract, nativeToScVal, Operation } from '@stellar/stellar-sdk';
import { getFillerAvailableBalances } from './filler.js';
import { APP_CONFIG } from './utils/config.js';
import { AuctioneerDatabase } from './utils/db.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';

/**
 * Helpers for backstop tier tokens.
 *
 * Interest auctions are bid on with the token of whichever backstop tier the pool selected,
 * and bad debt auctions pay out the selected tier's token. A tier token is one of: USDC, XLM, or a
 * Comet LP that contains USDC or XLM. The filler only holds USDC, and acquires tier tokens as needed.
 */

export enum TierTokenKind {
  USDC = 'usdc',
  XLM = 'xlm',
  COMET = 'comet',
}

export type TierTokenRoute =
  | { kind: TierTokenKind.USDC }
  | { kind: TierTokenKind.XLM }
  // `depositToken` is the comet's underlying token the filler deposits (either USDC or XLM)
  | { kind: TierTokenKind.COMET; depositToken: string };

// LP token amounts acquired include a small buffer to account for rounding
const BID_BUFFER_DIVISOR = 1000n;
// approvals for the backstop are short lived, so unused allowances expire quickly
const APPROVAL_LEDGERS = 1000;

export function getXlmAddress(): string {
  return Asset.native().contractId(APP_CONFIG.networkPassphrase);
}

/**
 * Determine how a tier token is acquired from USDC
 */
export async function getTierTokenRoute(
  token: string,
  sorobanHelper: SorobanHelper
): Promise<TierTokenRoute> {
  const xlm = getXlmAddress();
  if (token === APP_CONFIG.usdcAddress) {
    return { kind: TierTokenKind.USDC };
  } else if (token === xlm) {
    return { kind: TierTokenKind.XLM };
  }
  const cometTokens = await sorobanHelper.loadCometTokens(token);
  if (cometTokens.includes(APP_CONFIG.usdcAddress)) {
    return { kind: TierTokenKind.COMET, depositToken: APP_CONFIG.usdcAddress };
  } else if (cometTokens.includes(xlm)) {
    return { kind: TierTokenKind.COMET, depositToken: xlm };
  }
  throw new Error(`Unsupported tier token: ${token}`);
}

/**
 * Fetch the price of XLM in USDC. Uses the price from the DB (from the `priceSources` config) if available,
 * otherwise the pool's oracle price.
 */
export function getXlmPrice(poolOracle: PoolOracle, db: AuctioneerDatabase): number {
  const xlm = getXlmAddress();
  const price = db.getPriceEntry(xlm)?.price ?? poolOracle.getPriceFloat(xlm);
  if (price === undefined || price <= 0) {
    throw new Error(`Unable to find a price for XLM`);
  }
  return price;
}

/**
 * Value an amount of a tier token as the USDC required to acquire it
 * @param token - The tier token
 * @param amount - The amount of the tier token
 * @returns The USDC required to acquire "amount" of "token", as a float
 */
export async function valueTierTokenBid(
  token: string,
  amount: bigint,
  poolOracle: PoolOracle,
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<number> {
  const slippage = APP_CONFIG.slippage;
  const route = await getTierTokenRoute(token, sorobanHelper);
  switch (route.kind) {
    case TierTokenKind.USDC:
      return FixedMath.toFloat(amount, 7);
    case TierTokenKind.XLM:
      return FixedMath.toFloat(amount, 7) * getXlmPrice(poolOracle, db) * (1 + slippage);
    case TierTokenKind.COMET: {
      const depositIn = await sorobanHelper.simCometDepositTokenIn(
        token,
        route.depositToken,
        amount
      );
      if (depositIn === undefined) {
        throw new Error(`Failed to value tier token: ${token}`);
      }
      const depositInFloat = FixedMath.toFloat(depositIn, 7);
      return route.depositToken === APP_CONFIG.usdcAddress
        ? depositInFloat
        : depositInFloat * getXlmPrice(poolOracle, db) * (1 + slippage);
    }
  }
}

/**
 * Value an amount of a tier token as the USDC received by selling it
 * @param token - The tier token
 * @param amount - The amount of the tier token
 * @returns The USDC received by selling "amount" of "token", as a float
 */
export async function valueTierTokenLot(
  token: string,
  amount: bigint,
  poolOracle: PoolOracle,
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<number> {
  const slippage = APP_CONFIG.slippage;
  const route = await getTierTokenRoute(token, sorobanHelper);
  switch (route.kind) {
    case TierTokenKind.USDC:
      return FixedMath.toFloat(amount, 7);
    case TierTokenKind.XLM:
      return FixedMath.toFloat(amount, 7) * getXlmPrice(poolOracle, db) * (1 - slippage);
    case TierTokenKind.COMET: {
      // the backstop holds the tier's LP tokens, so it can be used as the holder for the simulation
      const withdrawOut = await sorobanHelper.simCometWithdrawTokenOut(
        token,
        route.depositToken,
        amount,
        APP_CONFIG.backstopAddress
      );
      if (withdrawOut === undefined) {
        throw new Error(`Failed to value tier token: ${token}`);
      }
      const withdrawOutFloat = FixedMath.toFloat(withdrawOut, 7);
      return route.depositToken === APP_CONFIG.usdcAddress
        ? withdrawOutFloat
        : withdrawOutFloat * getXlmPrice(poolOracle, db) * (1 - slippage);
    }
  }
}

/**
 * Prepare the filler to bid on an interest auction. Acquires the bid token with USDC, if necessary,
 * and approves the backstop to spend it.
 *
 * Each step is a separate transaction, so this is not atomic with the fill. If the fill does not happen,
 * any acquired tokens are kept and used for future bids.
 *
 * @param poolId - The pool the auction is in
 * @param auction - The interest auction
 * @param percent - The percent of the auction that will be filled
 * @param ledger - The earliest ledger the fill can occur. The bid amount does not increase over time, so
 *                 preparing for this ledger covers any later fill.
 */
export async function prepareInterestBid(
  poolId: string,
  auction: Auction,
  percent: number,
  ledger: number,
  sorobanHelper: SorobanHelper,
  db: AuctioneerDatabase
): Promise<void> {
  const [scaledAuction] = auction.scale(ledger, percent);
  for (const [token, amount] of scaledAuction.data.bid) {
    if (amount <= 0n) {
      continue;
    }
    const bidAmount = amount + amount / BID_BUFFER_DIVISOR + 1n;
    const poolOracle = await sorobanHelper.loadPoolOracle(poolId);
    await acquireTierToken(token, bidAmount, poolOracle, db, sorobanHelper);
    await approveBackstop(token, bidAmount, sorobanHelper);
  }
}

/**
 * Ensure the filler holds at least "amount" of a tier token, acquiring any shortfall with USDC
 */
export async function acquireTierToken(
  token: string,
  amount: bigint,
  poolOracle: PoolOracle,
  db: AuctioneerDatabase,
  sorobanHelper: SorobanHelper
): Promise<void> {
  const filler = APP_CONFIG.fillerKeypair.publicKey();
  const balance = (await getFillerAvailableBalances([token], sorobanHelper)).get(token) ?? 0n;
  if (balance >= amount) {
    return;
  }
  const shortfall = amount - balance;
  const route = await getTierTokenRoute(token, sorobanHelper);
  switch (route.kind) {
    case TierTokenKind.USDC:
      throw new Error(
        `Insufficient USDC to bid. Balance: ${FixedMath.toFloat(balance, 7)}, Required: ${FixedMath.toFloat(amount, 7)}`
      );
    case TierTokenKind.XLM:
      await buyXlm(shortfall, getXlmPrice(poolOracle, db), sorobanHelper);
      return;
    case TierTokenKind.COMET: {
      const depositIn = await sorobanHelper.simCometDepositTokenIn(
        token,
        route.depositToken,
        shortfall
      );
      if (depositIn === undefined) {
        throw new Error(`Failed to simulate minting ${shortfall} of tier token: ${token}`);
      }
      const maxDepositIn = FixedMath.toFixed(
        FixedMath.toFloat(depositIn, 7) * (1 + APP_CONFIG.slippage),
        7
      );
      if (route.depositToken !== APP_CONFIG.usdcAddress) {
        // depositing XLM - buy any XLM the filler is missing
        const xlmBalance =
          (await getFillerAvailableBalances([route.depositToken], sorobanHelper)).get(
            route.depositToken
          ) ?? 0n;
        if (xlmBalance < maxDepositIn) {
          await buyXlm(maxDepositIn - xlmBalance, getXlmPrice(poolOracle, db), sorobanHelper);
        }
      }
      const op = new Contract(token).call(
        'dep_lp_tokn_amt_out_get_tokn_in',
        nativeToScVal(route.depositToken, { type: 'address' }),
        nativeToScVal(shortfall, { type: 'i128' }),
        nativeToScVal(maxDepositIn, { type: 'i128' }),
        nativeToScVal(filler, { type: 'address' })
      );
      const result = await sorobanHelper.submitTransaction(
        op.toXDR('base64'),
        APP_CONFIG.fillerKeypair
      );
      logger.info(
        `Minted ${FixedMath.toFloat(shortfall, 7)} of tier token ${token} for filler ${filler}. Hash: ${result.txHash}`
      );
      return;
    }
  }
}

/**
 * Buy an exact amount of XLM with USDC on the Stellar DEX
 * @param amount - The amount of XLM to buy
 * @param xlmPrice - The price of XLM in USDC, used to set the max USDC spent
 */
export async function buyXlm(
  amount: bigint,
  xlmPrice: number,
  sorobanHelper: SorobanHelper
): Promise<void> {
  const [code, issuer] = APP_CONFIG.usdcAsset.split(':');
  const xlmAmount = FixedMath.toFloat(amount, 7);
  const sendMax = xlmAmount * xlmPrice * (1 + APP_CONFIG.slippage);
  const op = Operation.pathPaymentStrictReceive({
    sendAsset: new Asset(code, issuer),
    sendMax: sendMax.toFixed(7),
    destination: APP_CONFIG.fillerKeypair.publicKey(),
    destAsset: Asset.native(),
    destAmount: xlmAmount.toFixed(7),
    path: [],
  });
  const result = await sorobanHelper.submitClassicTransaction(op, APP_CONFIG.fillerKeypair);
  logger.info(`Bought ${xlmAmount} XLM for at most ${sendMax} USDC. Hash: ${result.txHash}`);
}

/**
 * Approve the backstop to spend "amount" of "token" from the filler, if the existing allowance is not enough.
 * The backstop pulls the bid via `transfer_from` when the auction is filled.
 */
export async function approveBackstop(
  token: string,
  amount: bigint,
  sorobanHelper: SorobanHelper
): Promise<void> {
  const filler = APP_CONFIG.fillerKeypair.publicKey();
  const currentLedger = await sorobanHelper.loadLatestLedger();
  const allowance = await sorobanHelper.loadAllowance(token, filler, APP_CONFIG.backstopAddress);
  // require the allowance to remain valid long enough to cover the fill
  if (allowance.amount >= amount && allowance.expiration_ledger > currentLedger + 50) {
    return;
  }
  const op = new Contract(token).call(
    'approve',
    nativeToScVal(filler, { type: 'address' }),
    nativeToScVal(APP_CONFIG.backstopAddress, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(currentLedger + APPROVAL_LEDGERS, { type: 'u32' })
  );
  const result = await sorobanHelper.submitTransaction(
    op.toXDR('base64'),
    APP_CONFIG.fillerKeypair
  );
  logger.info(
    `Approved backstop to spend ${FixedMath.toFloat(amount, 7)} of ${token} for filler ${filler}. Hash: ${result.txHash}`
  );
}
