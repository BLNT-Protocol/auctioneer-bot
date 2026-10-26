import { Asset } from '@stellar/stellar-sdk';
import { getTierTokenRoute } from './bid_token.js';
import { APP_CONFIG } from './utils/config.js';
import { logger } from './utils/logger.js';
import { SorobanHelper } from './utils/soroban_helper.js';

/**
 * Validates that the bot is mostly correctly configured. Attempts to catch any common misconfigurations
 * and error out if found to ensure the bot does not run in a broken state.
 *
 * @param sorobanHelper
 *
 * @throws Will throw an error if validation fails.
 */
export async function validateBot(sorobanHelper: SorobanHelper): Promise<void> {
  // validate the worker and filler keypairs are not the same
  if (APP_CONFIG.workerKeypair.publicKey() === APP_CONFIG.fillerKeypair.publicKey()) {
    throw new Error('Worker and filler keypairs must be different');
  }

  // validate the classic USDC asset matches the USDC contract, as it is used to buy XLM on the DEX
  const [code, issuer] = APP_CONFIG.usdcAsset.split(':');
  const usdcContract = new Asset(code, issuer).contractId(APP_CONFIG.networkPassphrase);
  if (usdcContract !== APP_CONFIG.usdcAddress) {
    throw new Error(
      `USDC asset mismatch. ${APP_CONFIG.usdcAsset} has contract ${usdcContract}, expected: ${APP_CONFIG.usdcAddress}`
    );
  }

  for (const poolConfig of APP_CONFIG.pools) {
    // validate each pool loads and that each pool has the same backstop
    const pool = await sorobanHelper.loadPool(poolConfig.poolAddress);
    if (pool.metadata.backstop !== APP_CONFIG.backstopAddress) {
      throw new Error(
        `Pool backstop mismatch for pool ${pool.id}. Expected: ${APP_CONFIG.backstopAddress}, Got: ${pool.metadata.backstop}`
      );
    }

    // validate the filler can acquire each tier token it is configured to bid with
    const tierTokens = await sorobanHelper.loadBackstopTierTokens(pool.id);
    logger.info(`Pool ${pool.id} backstop tier tokens: ${tierTokens}`);
    for (const token of tierTokens) {
      if (poolConfig.supportedBid.includes('*') || poolConfig.supportedBid.includes(token)) {
        await getTierTokenRoute(token, sorobanHelper);
      }
    }
  }
}
