import { SorobanHelper } from './utils/soroban_helper.js';
import { WorkSubmission, WorkSubmissionType } from './work_submitter.js';
import { logger } from './utils/logger.js';
import { FixedMath, AuctionType } from '@blend-capital/blend-sdk';
import { checkFillerSupport } from './filler.js';
import { APP_CONFIG, PoolConfig } from './utils/config.js';

/**
 * Check if an interest auction should be created for a pool.
 *
 * The pool selects the backstop tier, and only includes the tier's share of the backstop credit in the lot,
 * so the auction is simulated to determine the actual bid and lot.
 */
export async function checkPoolForInterestAuction(
  sorobanHelper: SorobanHelper,
  poolConfig: PoolConfig
): Promise<WorkSubmission | undefined> {
  try {
    const pool = await sorobanHelper.loadPool(poolConfig.poolAddress);
    const poolOracle = await sorobanHelper.loadPoolOracle(poolConfig.poolAddress);

    // check if there is an existing interest auction
    const interestAuction = await sorobanHelper.loadAuction(
      pool.id,
      APP_CONFIG.backstopAddress,
      AuctionType.Interest
    );
    if (interestAuction !== undefined) {
      logger.info(`Interest auction already exists for pool ${pool.id}`);
      return undefined;
    }

    // use the pools max auction lot size or at most 4 lot assets
    let maxLotAssets = Math.min(pool.metadata.maxPositions - 1, 4);
    let totalInterest = 0;
    let lotAssets = [];
    let backstopCredit: [string, number][] = [];
    for (const [assetId, reserve] of pool.reserves) {
      const assetPrice = poolOracle.getPrice(assetId) ?? BigInt(0);
      const priceFloat = FixedMath.toFloat(assetPrice, poolOracle.decimals);
      const creditFloat = FixedMath.toFloat(reserve.data.backstopCredit, reserve.config.decimals);
      backstopCredit.push([assetId, priceFloat * creditFloat]);
    }
    // sort by highest backstop credit first
    backstopCredit.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < backstopCredit.length; i++) {
      const [assetId, credit] = backstopCredit[i];
      if (credit < 1 || i >= maxLotAssets) {
        break;
      }
      totalInterest += credit;
      lotAssets.push(assetId);
    }
    if (totalInterest <= APP_CONFIG.minInterestValue) {
      logger.info(
        `No backstop interest auction needed for pool ${pool.id}, value: ${totalInterest}`
      );
      return undefined;
    }

    const auctionData = await sorobanHelper.simNewAuction(
      pool.id,
      AuctionType.Interest,
      APP_CONFIG.backstopAddress,
      [],
      lotAssets,
      100
    );
    if (auctionData === undefined) {
      logger.info(
        `No backstop interest auction available for pool ${pool.id}, lot assets: ${lotAssets}`
      );
      return undefined;
    }

    const bid = Array.from(auctionData.bid.keys());
    if (!checkFillerSupport(poolConfig, bid, lotAssets)) {
      logger.info(
        `Filler does not support backstop interest auction for pool ${pool.id}, bid: ${bid}, lot assets: ${lotAssets}`
      );
      return undefined;
    }

    // ensure the filler has enough USDC to acquire the bid token. The bid starts at 120% of the lot value,
    // and is typically filled after it decays below the lot value.
    let lotValue = 0;
    for (const [assetId, amount] of auctionData.lot) {
      const reserve = pool.reserves.get(assetId);
      const price = poolOracle.getPriceFloat(assetId) ?? 0;
      if (reserve !== undefined) {
        lotValue += FixedMath.toFloat(amount, reserve.config.decimals) * price;
      }
    }
    const usdcBalance = FixedMath.toFloat(
      await sorobanHelper.simBalance(APP_CONFIG.usdcAddress, APP_CONFIG.fillerKeypair.publicKey())
    );
    if (usdcBalance <= lotValue) {
      logger.error(
        `Filler does not have enough USDC to create backstop interest auction.\n` +
          `User: ${APP_CONFIG.fillerKeypair.publicKey()}\n` +
          `Balance: ${usdcBalance}\n` +
          `Required: ${lotValue}`
      );
      return undefined;
    }

    logger.info(
      `Creating backstop interest auction for pool ${pool.id}, value: ${lotValue}, bid: ${bid}, lot assets: ${lotAssets}`
    );
    return {
      type: WorkSubmissionType.AuctionCreation,
      poolId: pool.id,
      user: APP_CONFIG.backstopAddress,
      auctionType: AuctionType.Interest,
      auctionPercent: 100,
      // the pool selects the backstop tier when the auction is created
      bid: [],
      lot: lotAssets,
    };
  } catch (e) {
    logger.error(`Error checking backstop interest in pool ${poolConfig.poolAddress}: ${e}`);
    return undefined;
  }
}
