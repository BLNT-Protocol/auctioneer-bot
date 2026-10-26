import { Auction, AuctionType, FixedMath } from '@blend-capital/blend-sdk';
import { Keypair, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  acquireTierToken,
  approveBackstop,
  getTierTokenRoute,
  getXlmPrice,
  prepareInterestBid,
  TierTokenKind,
  valueTierTokenBid,
  valueTierTokenLot,
} from '../src/bid_token';
import { AuctioneerDatabase } from '../src/utils/db';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb, mockPoolOracle, USDC, XLM } from './helpers/mocks';

jest.mock('../src/utils/soroban_helper');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const FILLER = 'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT';
const BACKSTOP = 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO';
const BLNT = 'CCBNWP5L7ZSXA3DBWCMFAVKFVRW3ZHWO7B5J557W42O64DDZNPJP7VDS';
const BLNT_USDC_LP = 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3';
const BLNT_XLM_LP = 'CA5HX3D47PQZWC2E7VWXCKH4534P2NOJEOIXAWU47MI4QV2FQUYY3FLC';
const POOL = 'CACSQWCMKG45TUHCQ3LXHOB7YEEJH4W376ZHQPXH2IZ3TE4NJHFZMCY7';

jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      backstopAddress: 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      fillerKeypair: Keypair.fromPublicKey(
        'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT'
      ),
      usdcAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      slippage: 0.01,
      minInterestValue: 20,
    },
  };
});

/**
 * Decode a base64 invoke contract operation
 */
function decodeInvoke(op: string): { fn: string; args: any[] } {
  const invoke = xdr.Operation.fromXDR(op, 'base64')
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .invokeContract();
  return {
    fn: invoke.functionName().toString(),
    args: invoke.args().map((arg) => scValToNative(arg)),
  };
}

describe('bid_token', () => {
  let sorobanHelper: jest.Mocked<SorobanHelper>;
  let db: AuctioneerDatabase;
  let balances: Map<string, bigint>;
  // the mock oracle's XLM price
  const xlmPrice = 0.09899585234193;

  beforeEach(() => {
    jest.clearAllMocks();
    db = inMemoryAuctioneerDb();
    sorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    sorobanHelper.loadCometTokens.mockImplementation(async (comet: string) => {
      if (comet === BLNT_USDC_LP) return [BLNT, USDC];
      if (comet === BLNT_XLM_LP) return [BLNT, XLM];
      throw new Error('not a comet');
    });
    balances = new Map();
    sorobanHelper.loadBalances.mockImplementation(async (_user: string, tokens: string[]) => {
      return new Map(tokens.map((token) => [token, balances.get(token) ?? 0n]));
    });
    sorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    sorobanHelper.submitTransaction.mockResolvedValue({ txHash: 'hash', ledger: 1000 } as any);
    sorobanHelper.submitClassicTransaction.mockResolvedValue({
      txHash: 'hash',
      ledger: 1000,
    } as any);
  });

  describe('getTierTokenRoute', () => {
    it('routes each tier token type', async () => {
      expect(await getTierTokenRoute(USDC, sorobanHelper)).toEqual({ kind: TierTokenKind.USDC });
      expect(await getTierTokenRoute(XLM, sorobanHelper)).toEqual({ kind: TierTokenKind.XLM });
      expect(await getTierTokenRoute(BLNT_USDC_LP, sorobanHelper)).toEqual({
        kind: TierTokenKind.COMET,
        depositToken: USDC,
      });
      expect(await getTierTokenRoute(BLNT_XLM_LP, sorobanHelper)).toEqual({
        kind: TierTokenKind.COMET,
        depositToken: XLM,
      });
    });

    it('throws for comets without USDC or XLM', async () => {
      sorobanHelper.loadCometTokens.mockResolvedValue([BLNT, 'OTHER']);
      await expect(getTierTokenRoute('C_OTHER_LP', sorobanHelper)).rejects.toThrow(
        'Unsupported tier token'
      );
    });
  });

  describe('getXlmPrice', () => {
    it('uses the oracle price', () => {
      expect(getXlmPrice(mockPoolOracle, db)).toBeCloseTo(xlmPrice, 9);
    });

    it('prefers the db price', () => {
      db.setPriceEntries([{ asset_id: XLM, price: 0.2, timestamp: 1 }]);
      expect(getXlmPrice(mockPoolOracle, db)).toEqual(0.2);
    });
  });

  describe('valueTierTokenBid', () => {
    it('values USDC 1:1', async () => {
      const value = await valueTierTokenBid(USDC, 123_4567890n, mockPoolOracle, db, sorobanHelper);
      expect(value).toBeCloseTo(123.456789, 7);
      expect(sorobanHelper.simCometDepositTokenIn).not.toHaveBeenCalled();
    });

    it('values XLM with slippage', async () => {
      const value = await valueTierTokenBid(XLM, 100_0000000n, mockPoolOracle, db, sorobanHelper);
      expect(value).toBeCloseTo(100 * xlmPrice * 1.01, 7);
    });

    it('values a USDC comet LP as the USDC deposit required', async () => {
      sorobanHelper.simCometDepositTokenIn.mockResolvedValue(6_4000000n);
      const value = await valueTierTokenBid(
        BLNT_USDC_LP,
        100_0000000n,
        mockPoolOracle,
        db,
        sorobanHelper
      );
      expect(value).toBeCloseTo(6.4, 7);
      expect(sorobanHelper.simCometDepositTokenIn).toHaveBeenCalledWith(
        BLNT_USDC_LP,
        USDC,
        100_0000000n
      );
    });

    it('values an XLM comet LP as the XLM deposit required in USDC with slippage', async () => {
      sorobanHelper.simCometDepositTokenIn.mockResolvedValue(38_0000000n);
      const value = await valueTierTokenBid(
        BLNT_XLM_LP,
        100_0000000n,
        mockPoolOracle,
        db,
        sorobanHelper
      );
      expect(value).toBeCloseTo(38 * xlmPrice * 1.01, 7);
      expect(sorobanHelper.simCometDepositTokenIn).toHaveBeenCalledWith(
        BLNT_XLM_LP,
        XLM,
        100_0000000n
      );
    });

    it('throws if the comet simulation fails', async () => {
      sorobanHelper.simCometDepositTokenIn.mockResolvedValue(undefined);
      await expect(
        valueTierTokenBid(BLNT_USDC_LP, 100_0000000n, mockPoolOracle, db, sorobanHelper)
      ).rejects.toThrow('Failed to value tier token');
    });
  });

  describe('valueTierTokenLot', () => {
    it('values a comet LP as the withdrawal received, using the backstop as the holder', async () => {
      sorobanHelper.simCometWithdrawTokenOut.mockResolvedValue(6_3000000n);
      const value = await valueTierTokenLot(
        BLNT_USDC_LP,
        100_0000000n,
        mockPoolOracle,
        db,
        sorobanHelper
      );
      expect(value).toBeCloseTo(6.3, 7);
      expect(sorobanHelper.simCometWithdrawTokenOut).toHaveBeenCalledWith(
        BLNT_USDC_LP,
        USDC,
        100_0000000n,
        BACKSTOP
      );
    });

    it('values XLM with slippage', async () => {
      const value = await valueTierTokenLot(XLM, 100_0000000n, mockPoolOracle, db, sorobanHelper);
      expect(value).toBeCloseTo(100 * xlmPrice * 0.99, 7);
    });
  });

  describe('acquireTierToken', () => {
    it('does nothing if the filler holds enough of the token', async () => {
      balances.set(BLNT_USDC_LP, 100_0000000n);
      await acquireTierToken(BLNT_USDC_LP, 100_0000000n, mockPoolOracle, db, sorobanHelper);
      expect(sorobanHelper.submitTransaction).not.toHaveBeenCalled();
      expect(sorobanHelper.submitClassicTransaction).not.toHaveBeenCalled();
    });

    it('throws if the filler does not hold enough USDC', async () => {
      balances.set(USDC, 10_0000000n);
      await expect(
        acquireTierToken(USDC, 20_0000000n, mockPoolOracle, db, sorobanHelper)
      ).rejects.toThrow('Insufficient USDC to bid');
    });

    it('mints the shortfall of a USDC comet LP with USDC', async () => {
      balances.set(BLNT_USDC_LP, 40_0000000n);
      sorobanHelper.simCometDepositTokenIn.mockResolvedValue(4_0000000n);

      await acquireTierToken(BLNT_USDC_LP, 100_0000000n, mockPoolOracle, db, sorobanHelper);

      expect(sorobanHelper.simCometDepositTokenIn).toHaveBeenCalledWith(
        BLNT_USDC_LP,
        USDC,
        60_0000000n
      );
      expect(sorobanHelper.submitClassicTransaction).not.toHaveBeenCalled();
      expect(sorobanHelper.submitTransaction).toHaveBeenCalledTimes(1);
      const deposit = decodeInvoke(sorobanHelper.submitTransaction.mock.calls[0][0]);
      expect(deposit.fn).toEqual('dep_lp_tokn_amt_out_get_tokn_in');
      // token in, lp tokens out, max token in (1% slippage), user
      expect(deposit.args).toEqual([USDC, 60_0000000n, 4_0400000n, FILLER]);
    });

    it('buys missing XLM then mints the shortfall of an XLM comet LP', async () => {
      // 60 XLM held, but 50 XLM is reserved for fees
      balances.set(XLM, 60_0000000n);
      sorobanHelper.simCometDepositTokenIn.mockResolvedValue(38_0000000n);

      await acquireTierToken(BLNT_XLM_LP, 100_0000000n, mockPoolOracle, db, sorobanHelper);

      // max XLM in = 38 * 1.01 = 38.38, available = 10
      expect(sorobanHelper.submitClassicTransaction).toHaveBeenCalledTimes(1);
      const payment = sorobanHelper.submitClassicTransaction.mock.calls[0][0]
        .body()
        .pathPaymentStrictReceiveOp();
      expect(payment.destAsset().switch().name).toEqual('assetTypeNative');
      expect(payment.sendAsset().alphaNum4().assetCode().toString()).toContain('USDC');
      expect(payment.destAmount().toString()).toEqual('283800000');
      expect(Number(payment.sendMax().toString())).toBeCloseTo(28.38 * xlmPrice * 1.01 * 1e7, -1);
      expect(payment.path()).toEqual([]);

      expect(sorobanHelper.submitTransaction).toHaveBeenCalledTimes(1);
      const deposit = decodeInvoke(sorobanHelper.submitTransaction.mock.calls[0][0]);
      expect(deposit.args).toEqual([XLM, 100_0000000n, 38_3800000n, FILLER]);
    });

    it('buys the XLM shortfall for an XLM tier', async () => {
      balances.set(XLM, 70_0000000n);
      await acquireTierToken(XLM, 100_0000000n, mockPoolOracle, db, sorobanHelper);

      const payment = sorobanHelper.submitClassicTransaction.mock.calls[0][0]
        .body()
        .pathPaymentStrictReceiveOp();
      // 20 XLM available after the reserve
      expect(payment.destAmount().toString()).toEqual('800000000');
      expect(sorobanHelper.submitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('approveBackstop', () => {
    beforeEach(() => {
      sorobanHelper.loadLatestLedger.mockResolvedValue(5000);
    });

    it('does nothing if the allowance is enough', async () => {
      sorobanHelper.loadAllowance.mockResolvedValue({ amount: 100n, expiration_ledger: 5100 });
      await approveBackstop(USDC, 100n, sorobanHelper);
      expect(sorobanHelper.loadAllowance).toHaveBeenCalledWith(USDC, FILLER, BACKSTOP);
      expect(sorobanHelper.submitTransaction).not.toHaveBeenCalled();
    });

    it('approves if the allowance is too small', async () => {
      sorobanHelper.loadAllowance.mockResolvedValue({ amount: 99n, expiration_ledger: 5100 });
      await approveBackstop(USDC, 100n, sorobanHelper);
      const approve = decodeInvoke(sorobanHelper.submitTransaction.mock.calls[0][0]);
      expect(approve.fn).toEqual('approve');
      expect(approve.args).toEqual([FILLER, BACKSTOP, 100n, 6000]);
    });

    it('approves if the allowance expires too soon', async () => {
      sorobanHelper.loadAllowance.mockResolvedValue({ amount: 100n, expiration_ledger: 5050 });
      await approveBackstop(USDC, 100n, sorobanHelper);
      expect(sorobanHelper.submitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('prepareInterestBid', () => {
    it('acquires and approves the scaled bid plus a buffer', async () => {
      sorobanHelper.loadLatestLedger.mockResolvedValue(1250);
      sorobanHelper.loadAllowance.mockResolvedValue({ amount: 0n, expiration_ledger: 0 });
      balances.set(USDC, 1000_0000000n);
      const auction = new Auction(BACKSTOP, AuctionType.Interest, {
        bid: new Map([[USDC, 100_0000000n]]),
        lot: new Map([[XLM, 500_0000000n]]),
        block: 1000,
      });

      // 250 blocks in, the bid has decayed to 75%
      await prepareInterestBid(POOL, auction, 100, 1250, sorobanHelper, db);

      const expectedBid = 75_0000000n + 75_0000000n / 1000n + 1n;
      expect(sorobanHelper.loadPoolOracle).toHaveBeenCalledWith(POOL);
      const approve = decodeInvoke(sorobanHelper.submitTransaction.mock.calls[0][0]);
      expect(approve.fn).toEqual('approve');
      expect(approve.args[2]).toEqual(expectedBid);
    });

    it('does not submit anything if the filler is ready', async () => {
      sorobanHelper.loadLatestLedger.mockResolvedValue(1250);
      sorobanHelper.loadAllowance.mockResolvedValue({
        amount: FixedMath.toFixed(1000, 7),
        expiration_ledger: 2000,
      });
      balances.set(BLNT_USDC_LP, 1000_0000000n);
      const auction = new Auction(BACKSTOP, AuctionType.Interest, {
        bid: new Map([[BLNT_USDC_LP, 100_0000000n]]),
        lot: new Map([[XLM, 500_0000000n]]),
        block: 1000,
      });

      await prepareInterestBid(POOL, auction, 100, 1100, sorobanHelper, db);

      expect(sorobanHelper.submitTransaction).not.toHaveBeenCalled();
      expect(sorobanHelper.submitClassicTransaction).not.toHaveBeenCalled();
    });
  });
});
