import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { SorobanHelper } from '../../src/utils/soroban_helper';

const COMET = 'CDQMIKIHKA5UY3FQJ2UDTLNX3GOPD3GPNZWSPTOBVOHEUMQJQXOPC7Y3';
const TOKEN_IN = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const TOKEN_OUT = 'CCBNWP5L7ZSXA3DBWCMFAVKFVRW3ZHWO7B5J557W42O64DDZNPJP7VDS';
const I128_MAX = 2n ** 127n - 1n;

describe('SorobanHelper Comet quotes', () => {
  it('does not impose an artificial maximum input on exact-output deposits', async () => {
    const helper = Object.create(SorobanHelper.prototype) as SorobanHelper;
    const simCometCall = jest.fn().mockResolvedValue(1n);
    (helper as any).simCometCall = simCometCall;

    await helper.simCometDepositTokenIn(COMET, TOKEN_IN, 2_000_000_0000000n);

    const args = simCometCall.mock.calls[0][2];
    expect(scValToNative(args[2])).toBe(I128_MAX);
  });

  it('does not impose an artificial maximum input on exact-output swaps', async () => {
    const helper = Object.create(SorobanHelper.prototype) as SorobanHelper;
    const simCall = jest.fn().mockResolvedValue({
      transactionData: '',
      result: { retval: nativeToScVal([1n, 1n]) },
    });
    (helper as any).simCall = simCall;

    await helper.simCometSwapTokenIn(COMET, TOKEN_IN, TOKEN_OUT, 2_000_000_0000000n);

    const args = simCall.mock.calls[0][2];
    expect(scValToNative(args[1])).toBe(I128_MAX);
    expect(scValToNative(args[4])).toBe(I128_MAX);
  });
});
