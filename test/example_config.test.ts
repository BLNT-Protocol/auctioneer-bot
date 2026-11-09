import { StrKey } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const FIXED_POOL = 'CACSQWCMKG45TUHCQ3LXHOB7YEEJH4W376ZHQPXH2IZ3TE4NJHFZMCY7';
const YIELDBLENT_POOL = 'CAUTPSQDAJEUV5XEU3EXFVYRGDJLEJGVTFJCFZCSPTDCREAMZ573VF4D';
const BLNT_XLM = 'CA5HX3D47PQZWC2E7VWXCKH4534P2NOJEOIXAWU47MI4QV2FQUYY3FLC';
const BLNT_USDC = 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3';
const YIELDBLENT_RESERVES = [
  'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
  'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
  'CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE',
  'CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR',
  'CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV',
  'CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2',
  'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
  'CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN',
];

type ExamplePoolConfig = {
  poolAddress: string;
  primaryAsset: string;
  supportedBid: string[];
  supportedLot: string[];
};

describe('mainnet example config', () => {
  const config = JSON.parse(readFileSync('example.config.json', 'utf8')) as {
    pools: ExamplePoolConfig[];
  };
  const pools = new Map(config.pools.map((pool) => [pool.poolAddress, pool]));

  test('monitors Fixed and YieldBlent by default', () => {
    expect([...pools.keys()]).toEqual([FIXED_POOL, YIELDBLENT_POOL]);
  });

  test.each([FIXED_POOL, YIELDBLENT_POOL])('%s supports both canonical tier tokens', (pool) => {
    expect(pools.get(pool)?.supportedBid).toEqual(expect.arrayContaining([BLNT_XLM, BLNT_USDC]));
    expect(pools.get(pool)?.supportedLot).toEqual(expect.arrayContaining([BLNT_XLM, BLNT_USDC]));
  });

  test('supports every YieldBlent reserve as a bid and lot asset', () => {
    expect(pools.get(YIELDBLENT_POOL)?.supportedBid).toEqual(
      expect.arrayContaining(YIELDBLENT_RESERVES)
    );
    expect(pools.get(YIELDBLENT_POOL)?.supportedLot).toEqual(
      expect.arrayContaining(YIELDBLENT_RESERVES)
    );
  });

  test('contains only valid contract addresses', () => {
    for (const pool of pools.values()) {
      for (const address of [
        pool.poolAddress,
        pool.primaryAsset,
        ...pool.supportedBid,
        ...pool.supportedLot,
      ]) {
        expect(StrKey.isValidContract(address)).toBe(true);
      }
    }
  });
});
