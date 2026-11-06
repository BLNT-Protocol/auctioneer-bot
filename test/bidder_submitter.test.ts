import {
  Auction,
  FixedMath,
  PoolUser,
  Positions,
  Request,
  RequestType,
  ScaledAuction,
} from '@blend-capital/blend-sdk';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { AuctionFill, calculateAuctionFill } from '../src/auction';
import {
  AuctionBid,
  BidderSubmissionType,
  BidderSubmitter,
  FillerUnwind,
} from '../src/bidder_submitter';
import { prepareInterestBid } from '../src/bid_token';
import { getFillerAvailableBalances, managePositions } from '../src/filler';
import { AuctioneerDatabase, AuctionEntry, AuctionType, FilledAuctionEntry } from '../src/utils/db';
import { logger } from '../src/utils/logger';
import { sendNotification } from '../src/utils/notifier';
import { SorobanHelper } from '../src/utils/soroban_helper';
import { inMemoryAuctioneerDb, mockPool, mockPoolOracle } from './helpers/mocks';
import { stringify } from '../src/utils/json';
import { Api } from '@stellar/stellar-sdk/rpc';
import { APP_CONFIG } from '../src/utils/config';

// Mock dependencies

jest.mock('../src/utils/db');
jest.mock('../src/utils/soroban_helper');
jest.mock('../src/auction');
jest.mock('../src/utils/notifier');
jest.mock('../src/filler');
jest.mock('../src/bid_token');
jest.mock('../src/utils/soroban_helper');
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 999 }),
      })),
    },
  };
});

const fillerPubkey = 'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT';
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      rpcURL: 'http://localhost:8000/rpc',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      backstopAddress: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      fillerKeypair: Keypair.fromPublicKey(
        'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT'
      ),
      pools: [
        {
          poolAddress: 'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB', // mockPool.id
          primaryAsset: 'USD',
          minPrimaryCollateral: FixedMath.toFixed(100, 7),
          minHealthFactor: 1.1,
          defaultProfitPct: 0.05,
          forceFill: true,
          supportedBid: ['*'],
          supportedLot: ['*'],
        },
      ],
    },
  };
});

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('BidderSubmitter', () => {
  let bidderSubmitter: BidderSubmitter;
  let mockDb: AuctioneerDatabase;
  let mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  let mockedSorobanHelperConstructor = SorobanHelper as jest.MockedClass<typeof SorobanHelper>;
  mockedSorobanHelper.network = {
    rpc: 'test-rpc',
    passphrase: 'test-pass',
    opts: { allowHttp: true },
  };
  mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);

  const mockedSendSlackNotif = sendNotification as jest.MockedFunction<typeof sendNotification>;
  const mockedCalcAuctionFill = calculateAuctionFill as jest.MockedFunction<
    typeof calculateAuctionFill
  >;
  const mockedManagePositions = managePositions as jest.MockedFunction<typeof managePositions>;
  const mockedPrepareInterestBid = prepareInterestBid as jest.MockedFunction<
    typeof prepareInterestBid
  >;
  const mockedGetFilledAvailableBalances = getFillerAvailableBalances as jest.MockedFunction<
    typeof getFillerAvailableBalances
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    APP_CONFIG.auctionFillerAddress = undefined;
    mockDb = inMemoryAuctioneerDb();
    bidderSubmitter = new BidderSubmitter(mockDb);
  });

  it('should submit a bid successfully', async () => {
    bidderSubmitter.addSubmission = jest.fn();

    let auction = new Auction(Keypair.random().publicKey(), AuctionType.Liquidation, {
      bid: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot: new Map<string, bigint>([['USD', BigInt(2000)]]),
      block: 800,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction);
    let auction_fill: AuctionFill = {
      percent: 50,
      block: 1000,
      bidValue: 1.234,
      lotValue: 2.345,
      requests: [
        {
          request_type: RequestType.FillUserLiquidationAuction,
          address: auction.user,
          amount: 50n,
        },
      ],
    };
    mockedCalcAuctionFill.mockResolvedValue(auction_fill);
    let submissionResult: any = {
      // Inclusion is delayed 100 ledgers past the planned fill. The bid side
      // falls from 100% to 50%, while the lot remains at 100%.
      ledger: 1100,
      txHash: 'mock-tx-hash',
      latestLedgerCloseTime: Date.now(),
    };
    mockedSorobanHelper.submitTransaction.mockResolvedValue(submissionResult);

    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
        user_id: auction.user,
        auction_type: AuctionType.Liquidation,
        filler: fillerPubkey,
        start_block: 800,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    const expectedFillEntry: FilledAuctionEntry = {
      tx_hash: 'mock-tx-hash',
      pool_id: mockPool.id,
      filler: submission.auctionEntry.filler,
      user_id: auction.user,
      auction_type: submission.auctionEntry.auction_type,
      bid: new Map<string, bigint>([['USD', BigInt(250)]]),
      bid_total: auction_fill.bidValue / 2,
      lot: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot_total: auction_fill.lotValue,
      est_profit: auction_fill.lotValue - auction_fill.bidValue / 2,
      fill_block: submissionResult.ledger,
      timestamp: submissionResult.latestLedgerCloseTime,
    };
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      mockPool.id,
      submission.auctionEntry.user_id,
      submission.auctionEntry.auction_type
    );
    expect(mockedSorobanHelper.setFeeLevel).toHaveBeenCalledTimes(0);
    // only interest auctions require acquiring a bid token
    expect(mockedPrepareInterestBid).not.toHaveBeenCalled();
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalledWith(expectedFillEntry);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      {
        type: BidderSubmissionType.UNWIND,
        poolId: mockPool.id,
        filledAuction: {
          type: submission.auctionEntry.auction_type,
          user: submission.auctionEntry.user_id,
          scaleBlock: submissionResult.ledger,
          filled: false,
          fillHash: undefined,
          data: {
            bid: expectedFillEntry.bid,
            lot: expectedFillEntry.lot,
            block: submission.auctionEntry.start_block,
          },
        } as ScaledAuction,
      },
      2
    );
  });

  it('should submit a high includsion fee bid with high profit', async () => {
    bidderSubmitter.addSubmission = jest.fn();

    let auction = new Auction(Keypair.random().publicKey(), AuctionType.Liquidation, {
      bid: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot: new Map<string, bigint>([['USD', BigInt(2000)]]),
      block: 800,
    });
    mockedSorobanHelper.loadAuction.mockResolvedValue(auction);
    let auction_fill: AuctionFill = {
      percent: 50,
      block: 1000,
      bidValue: 12.34,
      lotValue: 23.45,
      requests: [
        {
          request_type: RequestType.FillUserLiquidationAuction,
          address: auction.user,
          amount: 50n,
        },
      ],
    };
    mockedCalcAuctionFill.mockResolvedValue(auction_fill);
    let submissionResult: any = {
      ledger: 1000,
      txHash: 'mock-tx-hash',
      latestLedgerCloseTime: Date.now(),
    };
    mockedSorobanHelper.submitTransaction.mockResolvedValue(submissionResult);

    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
        user_id: auction.user,
        auction_type: AuctionType.Liquidation,
        filler: fillerPubkey,
        start_block: 800,
        fill_block: 1000,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    const expectedFillEntry: FilledAuctionEntry = {
      tx_hash: 'mock-tx-hash',
      pool_id: mockPool.id,
      filler: submission.auctionEntry.filler,
      user_id: auction.user,
      auction_type: submission.auctionEntry.auction_type,
      bid: new Map<string, bigint>([['USD', BigInt(500)]]),
      bid_total: auction_fill.bidValue,
      lot: new Map<string, bigint>([['USD', BigInt(1000)]]),
      lot_total: auction_fill.lotValue,
      est_profit: auction_fill.lotValue - auction_fill.bidValue,
      fill_block: submissionResult.ledger,
      timestamp: submissionResult.latestLedgerCloseTime,
    };
    expect(result).toBe(true);
    expect(mockedSorobanHelper.loadAuction).toHaveBeenCalledWith(
      mockPool.id,
      submission.auctionEntry.user_id,
      submission.auctionEntry.auction_type
    );
    expect(mockedSorobanHelper.setFeeLevel).toHaveBeenCalledWith('high');
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(mockDb.setFilledAuctionEntry).toHaveBeenCalledWith(expectedFillEntry);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      {
        type: BidderSubmissionType.UNWIND,
        poolId: mockPool.id,
        filledAuction: {
          type: submission.auctionEntry.auction_type,
          user: submission.auctionEntry.user_id,
          scaleBlock: auction_fill.block,
          filled: false,
          fillHash: undefined,
          data: {
            bid: expectedFillEntry.bid,
            lot: expectedFillEntry.lot,
            block: submission.auctionEntry.start_block,
          },
        } as ScaledAuction,
      },
      2
    );
  });

  it('returns true if auction is undefined to return auction entry to handler', async () => {
    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadAuction.mockResolvedValue(undefined);
    mockedSorobanHelperConstructor.mockReturnValue(mockedSorobanHelper);
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        pool_id: mockPool.id,
        user_id: 'test-user',
        auction_type: AuctionType.Liquidation,
      } as AuctionEntry,
    };

    const result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
  });

  it('should manage positions during unwind', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [
      {
        request_type: RequestType.Repay,
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        amount: 123n,
      },
    ];

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', new Positions(new Map(), new Map(), new Map()), new Map())
    );
    mockedSorobanHelper.submitTransaction.mockResolvedValue({
      ledger: 12345,
      txHash: 'mock-tx-hash',
    } as Api.GetSuccessfulTransactionResponse);
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
      mockedSorobanHelper
    );
    expect(mockedManagePositions).toHaveBeenCalled();
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalled();
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(submission, 2);
  });

  it('should stop submitting unwind events when no action is taken', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [];

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', new Positions(new Map(), new Map(), new Map()), new Map())
    );
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.BadDebt,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
      mockedSorobanHelper
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(0);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
  });

  it('should stop submitting unwind events and send slack notification when liabilities remain', async () => {
    const fillerBalance = new Map<string, bigint>([['USD', 123n]]);
    const unwindRequest: Request[] = [];
    const fillerPositions = new Positions(new Map([[0, 123n]]), new Map([[1, 123n]]), new Map());

    bidderSubmitter.addSubmission = jest.fn();
    mockedSorobanHelper.loadPool.mockResolvedValue(mockPool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(mockPoolOracle);
    mockedSorobanHelper.loadUser.mockResolvedValue(
      new PoolUser('test-user', fillerPositions, new Map())
    );
    mockedGetFilledAvailableBalances.mockResolvedValue(fillerBalance);

    mockedManagePositions.mockReturnValue(unwindRequest);

    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: Keypair.random().publicKey(),
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };
    let result = await bidderSubmitter.submit(submission);

    expect(result).toBe(true);
    expect(mockedGetFilledAvailableBalances).toHaveBeenCalledWith(
      ['USD', ...Array.from(mockPool.reserves.keys())],
      mockedSorobanHelper
    );
    expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(0);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(0);
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Filler has liabilities that cannot be removed\n` +
        `Filler: ${fillerPubkey}\n` +
        `Pool: ${submission.poolId}\n` +
        `Positions: ${stringify(fillerPositions, 2)}`,
      'high'
    );
  });

  it('should recover persisted atomic claims without queuing duplicates', () => {
    const claim = {
      id: `${mockPool.id}:${AuctionType.Interest}:750`,
      filler_address: mockPool.id,
      pool_id: mockPool.id,
      auction_type: AuctionType.Interest,
      assets: ['USD'],
    };
    APP_CONFIG.auctionFillerAddress = mockPool.id;
    mockDb.getAllPendingClaimEntries = jest.fn().mockReturnValue([claim]);
    bidderSubmitter.addSubmission = jest.fn((submission, maxRetries) => {
      bidderSubmitter['submissions'].push({
        retries: maxRetries,
        timestamp: 0,
        minRetryTimeout: 1000,
        submission,
      });
    });

    bidderSubmitter.recoverPendingClaims();
    bidderSubmitter.recoverPendingClaims();

    expect(bidderSubmitter.addSubmission).toHaveBeenCalledTimes(1);
    expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BidderSubmissionType.UNWIND,
        poolId: mockPool.id,
        claimAuctionFiller: true,
        auctionFillerAddress: mockPool.id,
        pendingClaimId: claim.id,
        claimAssets: claim.assets,
      }),
      2
    );
  });

  it('should delete a persisted atomic claim only after a confirmed claim transaction', async () => {
    APP_CONFIG.auctionFillerAddress = mockPool.id;
    mockedSorobanHelper.submitTransaction.mockResolvedValue({
      ledger: 12345,
      txHash: 'claim-hash',
    } as Api.GetSuccessfulTransactionResponse);
    const pendingClaimId = `${mockPool.id}:${AuctionType.Interest}:750`;
    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      claimAuctionFiller: true,
      auctionFillerAddress: mockPool.id,
      pendingClaimId,
      claimAssets: ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'],
      filledAuction: {
        type: AuctionType.Interest,
        user: fillerPubkey,
        data: {
          bid: new Map(),
          lot: new Map([['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', 1n]]),
          block: 750,
        },
        scaleBlock: 1000,
        filled: true,
        fillHash: 'fill-hash',
      },
    };

    await expect(bidderSubmitter.submit(submission)).resolves.toBe(true);

    expect(mockDb.deletePendingClaimEntry).toHaveBeenCalledWith(pendingClaimId);
  });

  describe('interest auctions', () => {
    const tierToken = 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3';
    const backstop = 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO';
    let auction: Auction;
    let submission: AuctionBid;

    beforeEach(() => {
      bidderSubmitter.addSubmission = jest.fn();
      auction = new Auction(backstop, AuctionType.Interest, {
        bid: new Map<string, bigint>([[tierToken, BigInt(1000e7)]]),
        lot: new Map<string, bigint>([
          ['CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', BigInt(70e7)],
        ]),
        block: 750,
      });
      mockedSorobanHelper.loadAuction.mockResolvedValue(auction);
      mockedCalcAuctionFill.mockResolvedValue({
        percent: 100,
        block: 1000,
        bidValue: 60,
        lotValue: 70,
        requests: [
          { request_type: RequestType.FillInterestAuction, address: backstop, amount: 100n },
        ],
      });
      submission = {
        type: BidderSubmissionType.BID,
        auctionEntry: {
          pool_id: mockPool.id,
          user_id: backstop,
          auction_type: AuctionType.Interest,
          filler: fillerPubkey,
          start_block: 750,
          fill_block: 1000,
        } as AuctionEntry,
      };
    });

    it('prepares the bid token then fills the interest auction directly with the pool', async () => {
      mockedSorobanHelper.submitTransaction.mockResolvedValue({
        ledger: 1001,
        txHash: 'mock-tx-hash',
        latestLedgerCloseTime: Date.now(),
      } as any);

      const result = await bidderSubmitter.submit(submission);

      expect(result).toBe(true);
      // latest ledger is 999, so the next ledger is 1000
      expect(mockedPrepareInterestBid).toHaveBeenCalledWith(
        mockPool.id,
        auction,
        100,
        1000,
        mockedSorobanHelper,
        mockDb
      );
      expect(mockedSorobanHelper.submitTransaction).toHaveBeenCalledTimes(1);
      const submitOp = xdr.Operation.fromXDR(
        mockedSorobanHelper.submitTransaction.mock.calls[0][0],
        'base64'
      )
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract();
      expect(submitOp.functionName().toString()).toEqual('submit');
      expect(Address.fromScAddress(submitOp.contractAddress()).toString()).toEqual(mockPool.id);
      // the bid is prepared before the fill is submitted
      expect(mockedPrepareInterestBid.mock.invocationCallOrder[0]).toBeLessThan(
        mockedSorobanHelper.submitTransaction.mock.invocationCallOrder[0]
      );
      expect(mockedSorobanHelper.submitTransaction.mock.calls[0][2]).toEqual({
        prepareAuthForLedger: expect.any(Function),
      });
      expect(mockDb.setFilledAuctionEntry).toHaveBeenCalled();
      // the lot is sent directly to the filler, so no unwind is required
      expect(bidderSubmitter.addSubmission).not.toHaveBeenCalled();
    });

    it('persists an atomic lot claim before submitting the fill', async () => {
      const blnt = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV';
      const xlm = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
      const blntXlm = 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK';
      APP_CONFIG.auctionFillerAddress = mockPool.id;
      APP_CONFIG.auctionFillerBlntAddress = blnt;
      APP_CONFIG.auctionFillerXlmAddress = xlm;
      APP_CONFIG.auctionFillerBlntUsdcAddress = tierToken;
      APP_CONFIG.auctionFillerBlntXlmAddress = blntXlm;
      APP_CONFIG.slippage = 0.01;
      mockedSorobanHelper.simContractCall.mockResolvedValue(
        nativeToScVal(fillerPubkey, { type: 'address' })
      );
      mockedSorobanHelper.loadCometTokens
        .mockResolvedValueOnce([blnt, APP_CONFIG.usdcAddress])
        .mockResolvedValueOnce([blnt, xlm]);
      mockedSorobanHelper.simCometDepositTokenIn.mockResolvedValue(50_000_000n);
      mockedSorobanHelper.submitTransaction.mockResolvedValue({
        ledger: 1002,
        txHash: 'atomic-fill-hash',
        latestLedgerCloseTime: Date.now(),
      } as any);

      await expect(bidderSubmitter.submit(submission)).resolves.toBe(true);

      const pendingClaimId = `${mockPool.id}:${backstop}:${AuctionType.Interest}:750`;
      const setPendingClaim = mockDb.setPendingClaimEntry as jest.Mock;
      const setFilledAuction = mockDb.setFilledAuctionEntry as jest.Mock;
      expect(setPendingClaim).toHaveBeenCalledWith({
        id: pendingClaimId,
        filler_address: mockPool.id,
        pool_id: mockPool.id,
        auction_type: AuctionType.Interest,
        assets: [APP_CONFIG.usdcAddress],
      });
      expect(setPendingClaim.mock.invocationCallOrder[0]).toBeLessThan(
        mockedSorobanHelper.submitTransaction.mock.invocationCallOrder[0]
      );
      const recordedFill = setFilledAuction.mock.calls[0][0];
      expect(recordedFill.bid_total).toBeCloseTo(59.2);
      expect(recordedFill.lot_total).toBeCloseTo(70);
      expect(recordedFill.est_profit).toBeCloseTo(10.8);
      expect(recordedFill.fill_block).toBe(1002);
      expect(bidderSubmitter.addSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          claimAuctionFiller: true,
          auctionFillerAddress: mockPool.id,
          pendingClaimId,
          claimAssets: [APP_CONFIG.usdcAddress],
        }),
        2
      );
    });

    it('does not fill if preparing the bid fails', async () => {
      mockedPrepareInterestBid.mockRejectedValue(new Error('Insufficient USDC to bid'));

      const result = await bidderSubmitter.submit(submission);

      expect(result).toBe(false);
      expect(mockedSorobanHelper.submitTransaction).not.toHaveBeenCalled();
      expect(mockDb.setFilledAuctionEntry).not.toHaveBeenCalled();
    });
  });

  it('should return true if auction is in the queue', () => {
    const auctionEntry: AuctionEntry = {
      pool_id: mockPool.id,
      user_id: 'test-user',
      auction_type: AuctionType.Liquidation,
    } as AuctionEntry;

    bidderSubmitter.addSubmission(
      {
        type: BidderSubmissionType.BID,
        auctionEntry: auctionEntry,
      } as AuctionBid,
      1
    );

    expect(bidderSubmitter.containsAuction(auctionEntry)).toBe(true);
  });

  it('should return false if auction is not in the queue', () => {
    const auctionEntry: AuctionEntry = {
      pool_id: mockPool.id,
      user_id: 'test-user',
      auction_type: AuctionType.Liquidation,
    } as AuctionEntry;

    bidderSubmitter['submissions'] = [];

    expect(bidderSubmitter.containsAuction(auctionEntry)).toBe(false);
  });

  it('should distinguish auctions with the same type and user in different pools', () => {
    const queuedAuction: AuctionEntry = {
      pool_id: mockPool.id,
      user_id: 'test-user',
      auction_type: AuctionType.Interest,
    } as AuctionEntry;
    bidderSubmitter.addSubmission(
      {
        type: BidderSubmissionType.BID,
        auctionEntry: queuedAuction,
      } as AuctionBid,
      1
    );

    expect(
      bidderSubmitter.containsAuction({
        ...queuedAuction,
        pool_id: 'CB2GWHIXFZ2L6KTVKGWMLTV67B3HTGC4UKTHDLQHNWQE6O7VDXP3EAGT',
      })
    ).toBe(false);
  });

  it('should handle dropped bid', async () => {
    const submission: AuctionBid = {
      type: BidderSubmissionType.BID,
      auctionEntry: {
        user_id: 'test-user',
        pool_id: mockPool.id,
        auction_type: AuctionType.Liquidation,
        start_block: 900,
        fill_block: 1000,
      } as AuctionEntry,
    };

    await bidderSubmitter.onDrop(submission);

    expect(mockDb.deleteAuctionEntry).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledWith(
      `Dropped auction bid\n` +
        `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
        `Pool: ${mockPool.id}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${fillerPubkey}\n`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped auction bid\n` +
        `Type: ${AuctionType[submission.auctionEntry.auction_type]}\n` +
        `Pool: ${mockPool.id}\n` +
        `User: ${submission.auctionEntry.user_id}\n` +
        `Start Block: ${submission.auctionEntry.start_block}\n` +
        `Fill Block: ${submission.auctionEntry.fill_block}\n` +
        `Filler: ${fillerPubkey}\n`,
      'high'
    );
  });

  it('should handle dropped unwind', async () => {
    const submission: FillerUnwind = {
      type: BidderSubmissionType.UNWIND,
      poolId: mockPool.id,
      filledAuction: {
        type: AuctionType.Liquidation,
        user: fillerPubkey,
        data: {
          bid: new Map<string, bigint>(),
          lot: new Map<string, bigint>(),
          block: 0,
        },
        scaleBlock: 0,
        filled: true,
        fillHash: 'hash',
      },
    };

    await bidderSubmitter.onDrop(submission);

    expect(logger.error).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${fillerPubkey}\n` + `Pool: ${mockPool.id}`
    );
    expect(mockedSendSlackNotif).toHaveBeenCalledWith(
      `Dropped filler unwind\n` + `Filler: ${fillerPubkey}\n` + `Pool: ${mockPool.id}`,
      'high'
    );
  });
});
