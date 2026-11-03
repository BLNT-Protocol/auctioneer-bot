import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  AuctionFillerConfig,
  AuctionFillerContract,
  loadAndValidateAuctionFiller,
  planAtomicBid,
} from '../src/utils/auction_filler';
import { SorobanHelper } from '../src/utils/soroban_helper';

jest.mock('../src/utils/soroban_helper');

const OWNER = 'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT';
const FILLER = 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO';
const POOL = 'CACSQWCMKG45TUHCQ3LXHOB7YEEJH4W376ZHQPXH2IZ3TE4NJHFZMCY7';

jest.mock('../src/utils/config.js', () => ({
  APP_CONFIG: {
    auctionFillerAddress: 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO',
    auctionFillerBlntAddress: 'CCBNWP5L7ZSXA3DBWCMFAVKFVRW3ZHWO7B5J557W42O64DDZNPJP7VDS',
    auctionFillerXlmAddress: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    auctionFillerBlntUsdcAddress: 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3',
    auctionFillerBlntXlmAddress: 'CA5HX3D47PQZWC2E7VWXCKH4534P2NOJEOIXAWU47MI4QV2FQUYY3FLC',
    backstopAddress: 'CBLJQKOK6ZDQWXH2LHZHT32OAXA4I6JMCGAPZGEG4CHOUVD47ZAHGBST',
    fillerKeypair: Keypair.fromPublicKey(
      'GDMDYVZ7CQC2HLP3VONMAXQPGIQDNDQHQWLJZ7YTDGXUM32DVKOQHYGT'
    ),
    slippage: 0.01,
    usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  },
}));

const config: AuctionFillerConfig = {
  backstop: 'CBLJQKOK6ZDQWXH2LHZHT32OAXA4I6JMCGAPZGEG4CHOUVD47ZAHGBST',
  blnt: 'CCBNWP5L7ZSXA3DBWCMFAVKFVRW3ZHWO7B5J557W42O64DDZNPJP7VDS',
  blnt_usdc: 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3',
  blnt_xlm: 'CA5HX3D47PQZWC2E7VWXCKH4534P2NOJEOIXAWU47MI4QV2FQUYY3FLC',
  usdc: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  xlm: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
};

function decodeInvoke(op: string): { fn: string; args: unknown[] } {
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

describe('atomic auction filler', () => {
  let helper: jest.Mocked<SorobanHelper>;

  beforeEach(() => {
    jest.clearAllMocks();
    helper = new SorobanHelper() as jest.Mocked<SorobanHelper>;
  });

  it('loads route bindings from deployment config and validates only mutable owner on-chain', async () => {
    helper.simContractCall.mockResolvedValue(nativeToScVal(OWNER, { type: 'address' }));
    helper.loadCometTokens
      .mockResolvedValueOnce([config.blnt, config.usdc])
      .mockResolvedValueOnce([config.blnt, config.xlm]);

    await expect(loadAndValidateAuctionFiller(helper)).resolves.toEqual(config);
    expect(helper.simContractCall).toHaveBeenCalledTimes(1);
    expect(helper.simContractCall).toHaveBeenCalledWith(FILLER, 'get_owner', []);
  });

  it('plans every canonical interest tier and protocol-fee BLNT from USDC', async () => {
    helper.simCometDepositTokenIn.mockResolvedValue(200n);
    helper.simCometSwapTokenIn.mockResolvedValue(200n);

    await expect(planAtomicBid(config.usdc, 100n, config, helper)).resolves.toEqual({
      maxUsdcIn: 100n,
      maxBlntIn: 0n,
    });
    await expect(planAtomicBid(config.blnt_usdc, 100n, config, helper)).resolves.toEqual({
      maxUsdcIn: 202n,
      maxBlntIn: 0n,
    });
    await expect(planAtomicBid(config.blnt, 100n, config, helper)).resolves.toEqual({
      maxUsdcIn: 202n,
      maxBlntIn: 0n,
    });
    await expect(planAtomicBid(config.xlm, 100n, config, helper)).resolves.toEqual({
      maxUsdcIn: 202n,
      maxBlntIn: 202n,
    });
    await expect(planAtomicBid(config.blnt_xlm, 100n, config, helper)).resolves.toEqual({
      maxUsdcIn: 202n,
      maxBlntIn: 202n,
    });
  });

  it('builds the interest and protocol-fee entrypoints', () => {
    const contract = new AuctionFillerContract(FILLER);
    expect(
      decodeInvoke(contract.fillInterest(OWNER, POOL, 100, 200n, 0n, 123, config.blnt_usdc))
    ).toEqual({
      fn: 'fill_interest',
      args: [OWNER, POOL, 100, 200n, 0n, 123, config.blnt_usdc],
    });
    expect(decodeInvoke(contract.fillProtocolFee(OWNER, POOL, 100, 200n, 123))).toEqual({
      fn: 'fill_protocol_fee',
      args: [OWNER, POOL, 100, 200n, 123],
    });
  });
});
