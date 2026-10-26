import {
  Network,
  PoolConfig,
  PoolMetadata,
  PoolUser,
  PoolV2,
  Positions,
  ReserveConfigV2,
  ReserveData,
  ReserveV2,
} from '@blend-capital/blend-sdk';
import { Address, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

/**
 * Loaders for BLNT v3 pools.
 *
 * The v3 pool keeps the v2 storage layout for the data the bot uses (pool config, reserves, positions),
 * but adds storage keys and fields the blend-sdk v2 parsers reject (e.g. `AccessCtrl`, `BLNTTkn`, and
 * `carry_initialized` on emission data). These loaders only read the entries the bot needs, and skip
 * emissions entirely.
 */

/**
 * Load a v3 pool's metadata, ignoring any instance storage keys that are not needed.
 */
export async function loadPoolMetadataV3(network: Network, poolId: string): Promise<PoolMetadata> {
  const stellarRpc = new rpc.Server(network.rpc, network.opts);
  const contractAddress = Address.fromString(poolId).toScAddress();
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const reserveListKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: xdr.ScVal.scvSymbol('ResList'),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  let wasmHash: string | undefined;
  let admin: string | undefined;
  let name: string | undefined;
  let backstop: string | undefined;
  let poolConfig: PoolConfig | undefined;
  let reserveList: string[] | undefined;
  const entries = await stellarRpc.getLedgerEntries(instanceKey, reserveListKey);
  for (const entry of entries.entries ?? []) {
    const contractData = entry.val.contractData();
    const key = contractData.key();
    if (key.switch().name === 'scvLedgerKeyContractInstance') {
      const instance = contractData.val().instance();
      wasmHash = instance.executable().wasmHash()?.toString('hex');
      for (const instanceEntry of instance.storage() ?? []) {
        const instanceKey = instanceEntry.key();
        if (instanceKey.switch().name !== 'scvSymbol') {
          continue;
        }
        switch (instanceKey.sym().toString()) {
          case 'Admin':
            admin = Address.fromScVal(instanceEntry.val()).toString();
            break;
          case 'Backstop':
            backstop = Address.fromScVal(instanceEntry.val()).toString();
            break;
          case 'Config':
            poolConfig = PoolConfig.fromScVal(instanceEntry.val());
            break;
          case 'Name':
            name = instanceEntry.val().str().toString();
            break;
        }
      }
    } else if (key.switch().name === 'scvSymbol' && key.sym().toString() === 'ResList') {
      reserveList = scValToNative(contractData.val());
    }
  }

  if (
    wasmHash === undefined ||
    admin === undefined ||
    name === undefined ||
    backstop === undefined ||
    poolConfig === undefined ||
    reserveList === undefined
  ) {
    throw new Error(`Unable to parse v3 pool metadata for pool: ${poolId}`);
  }
  return new PoolMetadata(
    wasmHash,
    admin,
    name,
    backstop,
    poolConfig.backstopRate,
    poolConfig.maxPositions,
    poolConfig.minCollateral ?? 0n,
    poolConfig.oracle,
    poolConfig.status,
    reserveList,
    entries.latestLedger
  );
}

/**
 * Load a v3 pool. Reserve emissions are not loaded.
 */
export async function loadPoolV3(network: Network, poolId: string): Promise<PoolV2> {
  const metadata = await loadPoolMetadataV3(network, poolId);
  const timestamp = Math.floor(Date.now() / 1000);
  const stellarRpc = new rpc.Server(network.rpc, network.opts);

  const ledgerKeys: xdr.LedgerKey[] = [];
  for (const assetId of metadata.reserveList) {
    ledgerKeys.push(
      ReserveConfigV2.ledgerKey(poolId, assetId),
      ReserveData.ledgerKey(poolId, assetId)
    );
  }
  const entries = await stellarRpc.getLedgerEntries(...ledgerKeys);
  const configs = new Map<string, ReserveConfigV2>();
  const datas = new Map<string, ReserveData>();
  for (const entry of entries.entries) {
    // reserve keys are formatted as [Symbol, Address]
    const key = entry.val.contractData().key().vec();
    if (key === null || key.length !== 2) {
      continue;
    }
    const keyName = key[0].sym().toString();
    const assetId = Address.fromScVal(key[1]).toString();
    if (keyName === 'ResConfig') {
      configs.set(assetId, ReserveConfigV2.fromLedgerEntryData(entry.val));
    } else if (keyName === 'ResData') {
      datas.set(assetId, ReserveData.fromLedgerEntryData(entry.val));
    }
  }

  const reserves = new Map<string, ReserveV2>();
  for (const assetId of metadata.reserveList) {
    const config = configs.get(assetId);
    const data = datas.get(assetId);
    if (config === undefined || data === undefined) {
      throw new Error(`Unable to load v3 reserve: ${assetId} in pool: ${poolId}`);
    }
    const reserve = new ReserveV2(
      poolId,
      assetId,
      config,
      data,
      undefined,
      undefined,
      0,
      0,
      0,
      0,
      entries.latestLedger
    );
    reserve.accrue(BigInt(metadata.backstopRate), timestamp);
    reserves.set(assetId, reserve);
  }
  return new PoolV2(network, poolId, metadata, reserves, timestamp);
}

/**
 * Load a user's positions in a v3 pool. User emissions are not loaded.
 */
export async function loadPoolUserV3(
  network: Network,
  poolId: string,
  userId: string
): Promise<PoolUser> {
  const stellarRpc = new rpc.Server(network.rpc, network.opts);
  const entries = await stellarRpc.getLedgerEntries(Positions.ledgerKey(poolId, userId));
  const positions =
    entries.entries.length > 0
      ? Positions.fromLedgerEntryData(entries.entries[0].val)
      : new Positions(new Map(), new Map(), new Map());
  return new PoolUser(userId, positions, new Map());
}
