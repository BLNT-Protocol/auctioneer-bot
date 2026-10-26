import { Pool, PoolOracle, PoolV2, PriceData, ReserveV2 } from '@blend-capital/blend-sdk';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { AuctioneerDatabase } from '../../src/utils/db.js';
import { parse } from '../../src/utils/json.js';

const mockPoolPath = path.resolve(__dirname, 'mock-pool.json');
let pool = parse<PoolV2>(fs.readFileSync(mockPoolPath, 'utf8'));
pool.reserves.forEach((reserve, assetId, map) => {
  let parsedReserve = new ReserveV2(
    pool.id,
    assetId,
    reserve.config,
    reserve.data,
    reserve.borrowEmissions,
    reserve.supplyEmissions,
    reserve.borrowApr,
    0,
    reserve.supplyApr,
    0,
    reserve.latestLedger
  );
  parsedReserve.setRates(BigInt(pool.metadata.backstopRate));
  map.set(assetId, parsedReserve);
});
export let mockPool = pool;

export const MOCK_LEDGER = pool.metadata.latestLedger;
export const MOCK_TIMESTAMP = pool.timestamp;

export const XLM = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
export const XLM_ID = 0;
export const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
export const USDC_ID = 1;
export const EURC = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV';
export const EURC_ID = 2;
export const AQUA = 'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK';
export const AQUA_ID = 3;

export const BACKSTOP = 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO';
// BLNT:USDC Comet LP backstop tier token
export const TIER_TOKEN = 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3';

export let mockPoolOracle = new PoolOracle(
  'CATKK5ZNJCKQQWTUWIUFZMY6V6MOQUGSTFSXMNQZHVJHYF7GVV36FB3Y',
  new Map<string, PriceData>([
    [XLM, { price: BigInt(9899585234193), timestamp: 1724949300 }],
    [USDC, { price: BigInt(99969142646062), timestamp: 1724949300 }],
    [EURC, { price: BigInt(109278286319197), timestamp: 1724949300 }],
    [AQUA, { price: BigInt(64116899991), timestamp: 1724950800 }],
  ]),
  14,
  53255053
);

export function inMemoryAuctioneerDb(): AuctioneerDatabase {
  let db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../db/init_db.sql'), 'utf8'));
  return new AuctioneerDatabase(db);
}
