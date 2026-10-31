import { Address, nativeToScVal, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

export type PrepareAuthForLedger = (
  authEntries: xdr.SorobanAuthorizationEntry[],
  targetLedger: number
) => void;

/**
 * Rebuild a simulated transaction so it is valid for exactly the ledger its
 * authorization was prepared for. Ledger max bounds are exclusive.
 */
export function bindTransactionToNextLedger(
  transaction: Transaction,
  latestLedger: number,
  authEntries: xdr.SorobanAuthorizationEntry[],
  prepareAuth: PrepareAuthForLedger
): Transaction {
  const targetLedger = latestLedger + 1;
  prepareAuth(authEntries, targetLedger);
  return TransactionBuilder.cloneFrom(transaction, {
    ledgerbounds: {
      minLedger: targetLedger,
      maxLedger: targetLedger + 1,
    },
  }).build();
}

/**
 * Replace the ledger-sensitive amount authorized for backstop.donate during
 * an interest-auction fill. The pool recalculates this amount from the
 * execution ledger, so simulation authorization from an earlier ledger is not
 * valid without this adjustment.
 */
export function setInterestAuctionDonateAuth(
  authEntries: xdr.SorobanAuthorizationEntry[],
  backstopAddress: string,
  bidAmount: bigint
): void {
  let matches = 0;

  const updateInvocation = (invocation: xdr.SorobanAuthorizedInvocation): void => {
    const authorizedFunction = invocation.function();
    if (
      authorizedFunction.switch() ===
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
    ) {
      const contractFn = authorizedFunction.contractFn();
      const contractAddress = Address.fromScAddress(contractFn.contractAddress()).toString();
      if (
        contractAddress === backstopAddress &&
        contractFn.functionName().toString() === 'donate'
      ) {
        const args = contractFn.args();
        if (args.length !== 4) {
          throw new Error(
            `Unexpected backstop.donate authorization argument count: ${args.length}`
          );
        }
        args[3] = nativeToScVal(bidAmount, { type: 'i128' });
        matches++;
      }
    }

    for (const subInvocation of invocation.subInvocations()) {
      updateInvocation(subInvocation);
    }
  };

  for (const authEntry of authEntries) {
    updateInvocation(authEntry.rootInvocation());
  }

  // At ledger delta 400 the bid is zero and donate is skipped, so simulation
  // may legitimately omit it. A positive bid must authorize exactly one call.
  if (matches > 1 || (bidAmount > 0n && matches !== 1)) {
    throw new Error(`Expected one backstop.donate authorization, found ${matches}`);
  }
}
