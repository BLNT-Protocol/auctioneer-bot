import { Contract, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { APP_CONFIG } from './config.js';
import { SorobanHelper } from './soroban_helper.js';

export interface AuctionFillerConfig {
  backstop: string;
  blnt: string;
  blnt_usdc: string;
  blnt_xlm: string;
  usdc: string;
  xlm: string;
}

export interface AtomicBidPlan {
  maxUsdcIn: bigint;
  maxBlntIn: bigint;
}

const USDC_SCALAR = 10_000_000;

let validatedConfig: AuctionFillerConfig | undefined;

export class AuctionFillerContract {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  fillInterest(
    from: string,
    pool: string,
    fillPercent: number,
    maxUsdcIn: bigint,
    maxBlntIn: bigint,
    expectedAuctionBlock: number,
    expectedBidToken: string
  ): string {
    return new Contract(this.id)
      .call(
        'fill_interest',
        nativeToScVal(from, { type: 'address' }),
        nativeToScVal(pool, { type: 'address' }),
        nativeToScVal(fillPercent, { type: 'u32' }),
        nativeToScVal(maxUsdcIn, { type: 'i128' }),
        nativeToScVal(maxBlntIn, { type: 'i128' }),
        nativeToScVal(expectedAuctionBlock, { type: 'u32' }),
        nativeToScVal(expectedBidToken, { type: 'address' })
      )
      .toXDR('base64');
  }

  fillProtocolFee(
    from: string,
    pool: string,
    fillPercent: number,
    maxUsdcIn: bigint,
    expectedAuctionBlock: number
  ): string {
    return new Contract(this.id)
      .call(
        'fill_protocol_fee',
        nativeToScVal(from, { type: 'address' }),
        nativeToScVal(pool, { type: 'address' }),
        nativeToScVal(fillPercent, { type: 'u32' }),
        nativeToScVal(maxUsdcIn, { type: 'i128' }),
        nativeToScVal(expectedAuctionBlock, { type: 'u32' })
      )
      .toXDR('base64');
  }

  claim(to: string, assets: string[]): string {
    return new Contract(this.id)
      .call(
        'claim',
        nativeToScVal(to, { type: 'address' }),
        xdr.ScVal.scvVec(assets.map((asset) => nativeToScVal(asset, { type: 'address' })))
      )
      .toXDR('base64');
  }
}

export async function loadAndValidateAuctionFiller(
  sorobanHelper: SorobanHelper
): Promise<AuctionFillerConfig> {
  if (validatedConfig !== undefined) {
    return validatedConfig;
  }
  const id = APP_CONFIG.auctionFillerAddress;
  const blnt = APP_CONFIG.auctionFillerBlntAddress;
  const xlm = APP_CONFIG.auctionFillerXlmAddress;
  const blntUsdc = APP_CONFIG.auctionFillerBlntUsdcAddress;
  const blntXlm = APP_CONFIG.auctionFillerBlntXlmAddress;
  if (!id || !blnt || !xlm || !blntUsdc || !blntXlm) {
    throw new Error('Complete auction filler deployment configuration is required');
  }
  const ownerResult = await sorobanHelper.simContractCall(id, 'get_owner', []);
  if (!ownerResult) {
    throw new Error(`Unable to load auction filler owner from ${id}`);
  }
  const owner = scValToNative(ownerResult) as string;
  if (owner !== APP_CONFIG.fillerKeypair.publicKey()) {
    throw new Error(`Auction filler ${id} owner does not match the configured filler`);
  }
  const config: AuctionFillerConfig = {
    backstop: APP_CONFIG.backstopAddress,
    blnt,
    blnt_usdc: blntUsdc,
    blnt_xlm: blntXlm,
    usdc: APP_CONFIG.usdcAddress,
    xlm,
  };
  const [blntUsdcTokens, blntXlmTokens] = await Promise.all([
    sorobanHelper.loadCometTokens(config.blnt_usdc),
    sorobanHelper.loadCometTokens(config.blnt_xlm),
  ]);
  if (
    blntUsdcTokens.length !== 2 ||
    !blntUsdcTokens.includes(config.blnt) ||
    !blntUsdcTokens.includes(config.usdc) ||
    blntXlmTokens.length !== 2 ||
    !blntXlmTokens.includes(config.blnt) ||
    !blntXlmTokens.includes(config.xlm)
  ) {
    throw new Error(`Auction filler ${id} has invalid canonical Comet bindings`);
  }
  validatedConfig = config;
  return config;
}

function addSlippage(amount: bigint): bigint {
  const scalar = 1_000_000n;
  const multiplier = BigInt(Math.ceil((1 + APP_CONFIG.slippage) * Number(scalar)));
  return (amount * multiplier + scalar - 1n) / scalar;
}

/** Reject a submission-time quote that costs more than the quote approved as profitable. */
export function assertAtomicBidPlanWithinApprovedCost(
  plan: AtomicBidPlan,
  approvedBidValue: number
): void {
  const approvedMaxUsdcIn = Math.ceil(approvedBidValue * USDC_SCALAR);
  if (!Number.isSafeInteger(approvedMaxUsdcIn) || approvedMaxUsdcIn < 0) {
    throw new Error(`Invalid approved atomic auction bid value: ${approvedBidValue}`);
  }
  if (plan.maxUsdcIn > BigInt(approvedMaxUsdcIn)) {
    throw new Error(
      `Atomic auction bid re-quote exceeds approved USDC cost: ${plan.maxUsdcIn} > ${approvedMaxUsdcIn}`
    );
  }
}

async function requiredInput(value: Promise<bigint | undefined>, route: string): Promise<bigint> {
  const amount = await value;
  if (amount === undefined || amount <= 0n) {
    throw new Error(`Unable to quote atomic auction filler route: ${route}`);
  }
  return amount;
}

/** Quote conservative caps for acquiring one exact canonical bid token from USDC. */
export async function planAtomicBid(
  token: string,
  amount: bigint,
  config: AuctionFillerConfig,
  sorobanHelper: SorobanHelper
): Promise<AtomicBidPlan> {
  if (amount === 0n) {
    return { maxUsdcIn: 0n, maxBlntIn: 0n };
  }
  if (token === config.usdc) {
    return { maxUsdcIn: amount, maxBlntIn: 0n };
  }
  if (token === config.blnt_usdc) {
    const usdc = await requiredInput(
      sorobanHelper.simCometDepositTokenIn(config.blnt_usdc, config.usdc, amount),
      'USDC -> BLNT:USDC LP'
    );
    return { maxUsdcIn: addSlippage(usdc), maxBlntIn: 0n };
  }
  if (token === config.blnt) {
    const usdc = await requiredInput(
      sorobanHelper.simCometSwapTokenIn(config.blnt_usdc, config.usdc, config.blnt, amount),
      'USDC -> BLNT'
    );
    return { maxUsdcIn: addSlippage(usdc), maxBlntIn: 0n };
  }

  let requiredBlnt: bigint;
  if (token === config.xlm) {
    requiredBlnt = await requiredInput(
      sorobanHelper.simCometSwapTokenIn(config.blnt_xlm, config.blnt, config.xlm, amount),
      'BLNT -> XLM'
    );
  } else if (token === config.blnt_xlm) {
    requiredBlnt = await requiredInput(
      sorobanHelper.simCometDepositTokenIn(config.blnt_xlm, config.blnt, amount),
      'BLNT -> BLNT:XLM LP'
    );
  } else {
    throw new Error(`Unsupported auction filler bid token: ${token}`);
  }
  const maxBlntIn = addSlippage(requiredBlnt);
  const requiredUsdc = await requiredInput(
    sorobanHelper.simCometSwapTokenIn(config.blnt_usdc, config.usdc, config.blnt, maxBlntIn),
    'USDC -> intermediate BLNT'
  );
  return { maxUsdcIn: addSlippage(requiredUsdc), maxBlntIn };
}
