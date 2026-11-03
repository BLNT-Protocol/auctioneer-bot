import { AuctionType } from './db.js';

export const PROTOCOL_FEE_AUCTION_TYPE = 3;

export function auctionTypeName(type: number): string {
  return type === PROTOCOL_FEE_AUCTION_TYPE
    ? 'ProtocolFee'
    : (AuctionType[type] ?? `Unknown(${type})`);
}
