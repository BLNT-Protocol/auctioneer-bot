import {
  Auction,
  AuctionType,
  FixedMath,
  Network,
  PoolMetadata,
  PoolOracle,
  PoolV2,
  PriceData,
  Reserve,
  ReserveData,
} from '@blend-capital/blend-sdk';
import { Keypair } from '@stellar/stellar-sdk';
import { SorobanHelper } from '../src/utils/soroban_helper.js';
import { WorkSubmissionType } from '../src/work_submitter.js';
import { ReserveConfig } from '@blend-capital/blend-sdk';
import { checkPoolForInterestAuction } from '../src/interest.js';
import { APP_CONFIG, PoolConfig } from '../src/utils/config.js';

jest.mock('../src/utils/soroban_helper.js');
jest.mock('../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock('../src/utils/config.js', () => {
  return {
    APP_CONFIG: {
      backstopAddress: 'backstopAddress',
      usdcAddress: 'usdcAddress',
      minInterestValue: 20,
      fillerKeypair: Keypair.random(),
    },
  };
});

describe('checkPoolForInterestAuction', () => {
  const tierToken = 'tierToken';
  let mockedSorobanHelper: jest.Mocked<SorobanHelper>;
  let poolConfig: PoolConfig;

  beforeEach(() => {
    mockedSorobanHelper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
    APP_CONFIG.minInterestValue = 20;
    poolConfig = {
      poolAddress: 'pool1',
      minPrimaryCollateral: FixedMath.toFixed(100, 7),
      primaryAsset: 'USD',
      minHealthFactor: 1.1,
      defaultProfitPct: 0.05,
      forceFill: true,
      supportedBid: ['*'],
      supportedLot: ['*'],
    };
  });

  function mockPool(
    assets: string[],
    backstopCredit: bigint[],
    prices: bigint[],
    maxPositions: number = 6
  ) {
    const pool = buildPoolObject(
      'pool1',
      assets,
      backstopCredit,
      assets.map(() => 7)
    );
    pool.metadata.maxPositions = maxPositions;
    const poolOracle = buildPoolOracleObject(assets, prices, 7);
    mockedSorobanHelper.loadPool.mockResolvedValue(pool);
    mockedSorobanHelper.loadPoolOracle.mockResolvedValue(poolOracle);
  }

  it('creates an auction with an empty bid based on the simulated auction', async () => {
    // total credit value is 35
    mockPool(
      ['asset1', 'asset2', 'asset3'],
      [BigInt(20e7), BigInt(2e7), BigInt(10e7)],
      [BigInt(1e7), BigInt(4e7), BigInt(0.7e7)]
    );
    // the pool only includes the selected tier's share of the credit in the lot
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([
        ['asset1', BigInt(10e7)],
        ['asset2', BigInt(1e7)],
      ]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(15e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(mockedSorobanHelper.simNewAuction).toHaveBeenCalledWith(
      'pool1',
      AuctionType.Interest,
      'backstopAddress',
      [],
      ['asset1', 'asset2', 'asset3'],
      100
    );
    expect(mockedSorobanHelper.simBalance).toHaveBeenCalledWith(
      'usdcAddress',
      APP_CONFIG.fillerKeypair.publicKey()
    );
    expect(result).toEqual({
      type: WorkSubmissionType.AuctionCreation,
      poolId: 'pool1',
      auctionType: AuctionType.Interest,
      user: 'backstopAddress',
      auctionPercent: 100,
      bid: [],
      lot: ['asset1', 'asset2', 'asset3'],
    });
  });

  it('returns undefined if an interest auction already exists', async () => {
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);
    mockedSorobanHelper.loadAuction.mockResolvedValue({} as Auction);

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
    expect(mockedSorobanHelper.simNewAuction).not.toHaveBeenCalled();
  });

  it('includes at most 4 lot assets', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4', 'asset5'];
    mockPool(
      assets,
      assets.map((_, i) => BigInt((10 + i) * 1e7)),
      assets.map(() => BigInt(1e7))
    );
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset5', BigInt(14e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect((result as any).lot).toEqual(['asset5', 'asset4', 'asset3', 'asset2']);
  });

  it('respects pool max positions', async () => {
    const assets = ['asset1', 'asset2', 'asset3', 'asset4'];
    mockPool(
      assets,
      [BigInt(105e7), BigInt(10e7), BigInt(200e7), BigInt(100e7)],
      [BigInt(1e7), BigInt(4e7), BigInt(0.5e7), BigInt(2e7)],
      3
    );
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset4', BigInt(50e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect((result as any).lot).toEqual(['asset4', 'asset1']);
  });

  it('ignores assets with less than 1 unit of credit value', async () => {
    mockPool(['asset1', 'asset2'], [BigInt(40e7), BigInt(0.5e7)], [BigInt(1e7), BigInt(1e7)]);
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset1', BigInt(40e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect((result as any).lot).toEqual(['asset1']);
  });

  it('returns undefined if credit is below the configured minimum', async () => {
    APP_CONFIG.minInterestValue = 50;
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
    expect(mockedSorobanHelper.simNewAuction).not.toHaveBeenCalled();
  });

  it('returns undefined if the pool would reject the auction', async () => {
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);
    mockedSorobanHelper.simNewAuction.mockResolvedValue(undefined);

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });

  it('returns undefined if the filler does not support the selected tier token', async () => {
    poolConfig.supportedBid = ['otherTierToken'];
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset1', BigInt(40e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });

  it('returns undefined if the filler does not support the lot assets', async () => {
    poolConfig.supportedLot = ['asset2'];
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset1', BigInt(40e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(1000e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });

  it('returns undefined if the filler does not have enough USDC for the lot value', async () => {
    mockPool(['asset1'], [BigInt(40e7)], [BigInt(1e7)]);
    mockedSorobanHelper.simNewAuction.mockResolvedValue({
      bid: new Map([[tierToken, BigInt(500e7)]]),
      lot: new Map([['asset1', BigInt(40e7)]]),
      block: 123,
    });
    mockedSorobanHelper.simBalance.mockResolvedValue(BigInt(39e7));

    const result = await checkPoolForInterestAuction(mockedSorobanHelper, poolConfig);

    expect(result).toBeUndefined();
  });
});

function buildPoolObject(
  id: string,
  assets: string[],
  backstopCredit: bigint[],
  decimals: number[]
): PoolV2 {
  const pool = new PoolV2(
    {} as Network,
    id,
    {
      maxPositions: 6,
      oracle: 'oracleId',
    } as PoolMetadata,
    new Map<string, Reserve>(
      assets.map((asset, index) => [
        asset,
        {
          config: { decimals: decimals[index] } as ReserveConfig,
          data: {
            bRate: BigInt(1_000_000_000_000),
            backstopCredit: backstopCredit[index],
          } as ReserveData,
        } as Reserve,
      ])
    ),
    1723578353
  );

  return pool;
}

function buildPoolOracleObject(assets: string[], prices: bigint[], decimals: number): PoolOracle {
  const poolOracle = new PoolOracle(
    'pool1',
    new Map<string, PriceData>(
      assets.map((asset, index) => [asset, { price: prices[index], timestamp: 1724950800 }])
    ),
    decimals,
    53255053
  );

  return poolOracle;
}
