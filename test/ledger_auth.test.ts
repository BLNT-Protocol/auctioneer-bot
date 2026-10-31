import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  bindTransactionToNextLedger,
  setInterestAuctionDonateAuth,
} from '../src/utils/ledger_auth';

const NETWORK = 'Test SDF Network ; September 2015';
const POOL = 'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB';
const BACKSTOP = 'CAHCUKBPTW5DR5RNXOHCTJD5U76A6EEZXYZAQFRQEEQRXQ3CRUZ6Z3MO';

function contractInvocation(
  contractAddress: string,
  functionName: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = []
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractAddress).toScAddress(),
        functionName,
        args,
      })
    ),
    subInvocations,
  });
}

function interestAuth(amount: bigint): xdr.SorobanAuthorizationEntry {
  const donate = contractInvocation(BACKSTOP, 'donate', [
    nativeToScVal(0, { type: 'u32' }),
    nativeToScVal(Address.fromString(POOL)),
    nativeToScVal(Address.fromString(POOL)),
    nativeToScVal(amount, { type: 'i128' }),
  ]);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: contractInvocation(POOL, 'submit', [], [donate]),
  });
}

describe('ledger-sensitive authorization', () => {
  it('updates the nested backstop donation amount', () => {
    const auth = interestAuth(100n);

    setInterestAuctionDonateAuth([auth], BACKSTOP, 90n);

    const donateArgs = auth.rootInvocation().subInvocations()[0].function().contractFn().args();
    expect(scValToNative(donateArgs[3])).toBe(90n);
  });

  it('rejects a positive bid without a matching donation authorization', () => {
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: contractInvocation(POOL, 'submit', []),
    });

    expect(() => setInterestAuctionDonateAuth([auth], BACKSTOP, 90n)).toThrow(
      'Expected one backstop.donate authorization, found 0'
    );
  });

  it('binds the transaction to the ledger after simulation', () => {
    const operation = new Contract(POOL).call('submit');
    const transaction = new TransactionBuilder(
      new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1'),
      { fee: BASE_FEE, networkPassphrase: NETWORK }
    )
      .addOperation(operation)
      .setTimeout(30)
      .build();
    const auth = interestAuth(100n);
    const prepareAuth = jest.fn((entries: xdr.SorobanAuthorizationEntry[], ledger: number) => {
      setInterestAuctionDonateAuth(entries, BACKSTOP, BigInt(ledger));
    });

    const bounded = bindTransactionToNextLedger(transaction, 999, [auth], prepareAuth);

    expect(prepareAuth).toHaveBeenCalledWith([auth], 1000);
    expect(bounded.ledgerBounds).toEqual({ minLedger: 1000, maxLedger: 1001 });
    const donateArgs = auth.rootInvocation().subInvocations()[0].function().contractFn().args();
    expect(scValToNative(donateArgs[3])).toBe(1000n);
  });
});
