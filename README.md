# Auctioneer Bot

The auctioneer bot monitors BLNT v3 pools to create and bid on auctions. This includes user liquidation auctions, bad debt auctions, and interest auctions. The auctioneer focuses on completeness and pool safety over profit, but the existing code can be modified to meet any use case.

The BLNT v3 contracts are derived from Blend v2. For background on pools and auctions, see [the Blend docs](https://docs.blend.capital/tech-docs/core-contracts/lending-pool) and the [BLNT v3 contract specification](https://github.com/BLNT-Protocol/blnt-contracts-v3/blob/main/docs/V3_SYSTEM_SPEC.md).

## Safety

This software is made available under the MIT License, which disclaims all warranties in relation to the project and which limits the liability of those that contribute and maintain the project, including Script3. You acknowledge that you are solely responsible for any use of this software and you assume all risks associated with any such use.

## Getting Started

It is recommended to run the auctioneer bot as a docker container. Build the image with:

```bash
npm ci
npm run build
docker build -t auctioneer-bot:blnt-v3 .
```

Prebuilt images (amd64 and arm64) are published to `ghcr.io/blnt-protocol/auctioneer-bot` by the Publish Docker workflow: `:dev` tracks `main`, and version tags `vX.Y.Z` publish `:X.Y.Z`, `:X.Y` and `:latest`.

To run the container, you will need to mount a directory from the host to `/app/data` on the container. The directory must contain a config file named `config.json` at its root. Please see [Configuration](#configuration) for details on the configuration file.

The container will create a sqlite3 database that tracks bot activity and log files in the mounted directory.

Use the following command to run the container:
```bash
docker run --restart always -d -v /path/on/host:/app/data auctioneer-bot:blnt-v3
```

The auctioneer bot requires access to a Soroban RPC server, and is fairly chatty. We recommend running an Soroban RPC server on the same host to avoid issues with rate limiting / usage. Please see the Stellar documentation for running a [Soroban RPC](https://developers.stellar.org/docs/data/rpc). We recommend running the [Soroban RPC as a docker container](https://developers.stellar.org/docs/data/rpc/admin-guide#docker-image). The Auctioneer bot itself is not very resource intensive, and should work fine alongside an RPC with the suggested hardware requirements for the Soroban RPC server.

The auctioneer bot also (optionally) uses Horizon to fetch prices from the DEX. If you use this, the bot keeps usage low (up to 1 request a minute per asset), so using a public Horizon endpoint should be OK. However, it is recommended to use a Horizon hosting solution to ensure uptime (e.g. Blockdaemon or Quicknode).

Auctions filled by the bot will have an entry populated in the `filled_auctions` table of the DB, with the bots estimated profit on the trade included.

## Important Info

This bot does not automatically unwind all positions it bids on. It is recommended to manually adjust your positions as necessary as auctions get filled.

Certain auctions cause your filler to take on liabilities, and if these assets are not cleared in a timely manner, could result in the filler also getting liquidated.

### Backstop Tiers

Each pool has up to three backstop tiers, and interest auctions rotate between them. The bid for an interest auction is the token of the selected tier: USDC, XLM, or a Comet LP containing USDC or XLM (e.g. BLNT:USDC or BLNT:XLM). The filler only needs to hold USDC, and acquires the bid token right before filling:

* **USDC** - used directly.
* **Comet LP with USDC** (e.g. BLNT:USDC) - minted with a single sided USDC deposit.
* **Comet LP with XLM** (e.g. BLNT:XLM) - XLM is bought with USDC on the Stellar DEX, then minted with a single sided XLM deposit.
* **XLM** - bought with USDC on the Stellar DEX.

The filler then approves the backstop to spend exactly the bid amount, and fills the auction directly with the pool. These are separate transactions, so acquiring the bid token is not atomic with the fill. If the fill does not happen (e.g. another filler wins the auction), the acquired tokens are kept by the filler and used for future bids. The filler keeps 50 XLM in reserve for fees, and needs a trustline to the USDC asset.

Interest auction lots are sent directly to the filler, and are not sold back to USDC.

### Auctions

* **Interest auctions** are created with an empty bid, letting the pool select the tier. The bot simulates the auction first, as the pool only includes the selected tier's share of the backstop credit in the lot. Lots can include up to 4 assets, and the backstop credit must be over `minInterestValue`.
* **Bad debt auctions** are created with an empty bid and lot, letting the pool select the debt and tier. Lots are the selected tier's token, and are valued as the USDC received by selling it.
* **User liquidation auctions** are unchanged from Blend v2.
* **Protocol fee auctions** (auction type 3) are ignored.

The tier tokens must be included in `supportedBid` to bid on interest auctions, and in `supportedLot` to bid on bad debt auctions. The bot logs each pool's tier tokens on startup.

### Configuration

For an example config file that is configured to interact with the BLNT v3 mainnet deployment, please see [example.config.json](./example.config.json).

#### General Settings

| Field | Description |
|-------|-------------|
| `name` | A descriptive name for your bot instance. |
| `rpcURL` | The URL of the Soroban RPC endpoint. |
| `networkPassphrase` | The network passphrase identifying the Stellar network. |
| `backstopAddress` | The address of the BLNT v3 backstop contract. |
| `usdcAddress` | The address of the USDC token contract. |
| `usdcAsset` | The classic Stellar asset for `usdcAddress`, formatted as `code:issuer`. Used to buy XLM on the DEX. |
| `workerKeypair` | The secret key for the bot's auction creating account. This should be different from the filler as auction creation and auction bidding can happen simultaneously. **Keep this secret and secure!** |
| `fillerKeypair` | The secret key for the bot's auction filler account. This should be different from the worker as auction creation and auction bidding can happen simultaneously. **Keep this secret and secure!** |
| `pools` | A list of pool configs that dictates what pools are monitored |
| `slippage` | (Default - `0.01`) The max slippage allowed when buying XLM or minting LP tokens, as a decimal. Also used to discount XLM based bid and lot valuations. |
| `minInterestValue` | (Default - `20`) The minimum backstop credit value (in oracle units) required to attempt to create an interest auction. The pool requires the selected tier's share to be at least 20 USDC. |
| `notificationLevel` | (Default - `med`) The severity level where notifications are sent to either the console or a webhook, if present. Can be one of `low`, `med`, or `high`. High notifications includes dropped actions, bad debt auctions, critical errors and liquidation auction fills. Med adds interest auction fills, liquidation auctions, and retried errors. Low adds additional info notifications and interest auctions. |
| `baseFee` | (Default - `5000`) The minimum inclusion fee that will be specified for a normal transaction, otherwise feeStats p70. |
| `highBaseFee` | (Default - `10000`) The minimum inclusion fee that will be specified for a high priority transaction, otherwise feeStats p90. This is considered any auction fill where the estimated profit is over 10 oracle units (almost always $10). |
| `horizonURL` | (Optional) The URL of a Horizon server, used for DEX price sources. |
| `priceSources` | (Optional) A list of assets that will have prices sourced from exchanges instead of the pool oracle. A price source for XLM is recommended, as it is used when buying XLM. |
| `profits` | (Optional) A list of auction profits to define different profit percentages used for matching auctions. |
| `slackWebhook` | (Optional) A slack webhook URL to post updates to (https://hooks.slack.com/services/). Leave undefined if no webhooks are required. |
| `discordWebhook` | (Optional) A Discord webhook URL to post updates to. Leave undefined if no webhooks are required. |

#### Pool Config

The `pools` array contains configurations for individual pools to monitor. Each pool configuration has the following properties:

| Field | Description |
|-------|-------------|
| `poolAddress` | The address of the pool to monitor. |
| `minPrimaryCollateral` | The minimum amount of the primary asset that is maintained as collateral in the pool. |
| `primaryAsset` | The primary asset the bot will use as collateral in the pool. |
| `minHealthFactor` | The minimum health factor the bot will take on during liquidation and bad debt auctions, as calculated by `collateral / liabilities`. |
| `defaultProfitPct` | The default profit percentage required to bid on an auction, as a decimal. (e.g. 0.08 = 8%) |
| `forceFill` | Boolean flag to indicate if the bot should force fill auctions even if profit expectations aren't met to ensure pool health. |
| `supportedBid` | An array of asset addresses that the bot is allowed to bid with. Bids are taken as additional liabilities (dTokens) for liquidation and bad debt auctions, and tier tokens for interest auctions. Must include the pool's tier tokens to bid on interest auctions. |
| `supportedLot` | An array of asset addresses that the bot is allowed to receive. Lots are given as collateral (bTokens) for liquidation auctions, reserve tokens for interest auctions, and tier tokens for bad debt auctions. The bot should have trustlines to all assets that are Stellar assets. Must include the pool's tier tokens to bid on bad debt auctions. |

#### Price Sources

The `priceSources` array defines the additional sources for price data. If an asset has a price source, the oracle prices will not be used when calculating profit, and instead the price fetched from the price source will be. 

##### Exchange Price Sources

Prices are fetched from the following endpoints:
* Coinbase: https://api.coinbase.com/api/v3/brokerage/market/products?product_ids=SYMBOL
* Binance: https://api.binance.com/api/v3/ticker/price?symbols=[SYMBOL]

Each exchange price source has the following fields:

| Field | Description |
|-------|-------------|
| `assetId` | The address of the asset for which this price source provides data. |
| `type` | The type of price source (e.g., "coinbase", "binance"). |
| `symbol` | The trading symbol used by the price source for this asset. |

##### DEX Prices Sources

DEX prices sources are calculated via Horizon's "find strict receive payment path" endpoint. The specified `destAmount` will be received via the `sourceAsset` asset, and the price will be computed such that `sourceAmount / destAmount`, or the average price for the full path payment operation on that block. This can be useful to fetch prices for assets that are not on centralized exchanges.

Each DEX price source has the following fields:

| Field | Description |
|-------|-------------|
| `assetId` | The address of the asset for which this price source provides data. |
| `type` | The type of price source (e.g., "dex"). |
| `sourceAsset` | The Stellar Asset being used as the source asset. Should align with the contract address in `assetId`. The string is formatted as `code:issuer` or `XLM:native`. |
| `destAsset` | The Stellar Asset being used as the destination asset. This should be what the oracle is reporting in (e.g. USDC). The string is formatted as `code:issuer` or `XLM:native`.
| `destAmount` | The amount of `destAsset` that must be received to calculate the final price of `sourceAsset` |

#### Profits

The `profits` list defines target profit percentages based on the assets that make up the bid and lot of a given auction. This allows fillers to have flexibility in the profit they target. The profit percentage chosen will be the first entry in the `profits` list that supports all bid and lot assets in the auction. If no profit entry is found, the `defaultProfitPct` value defined by the filler will be used.

Each profit entry has the following fields:

| Field | Description |
|-------|-------------|
| `profitPct` | The profit percentage required to bid for the auction, as a decimal. (e.g. 0.08 = 8%) |
| `supportedBid` | An array of asset addresses that the auction bid can contain for this `profitPct` to be used. If any auction bid asset exists outside this list, the `profitPct` will not be used. |
| `supportedLot` | An array of asset addresses that the auction lot can contain for this `profitPct` to be used. If any auction lot asset exists outside this list, the `profitPct` will not be used. |

## Build

To build a docker image for a specific platform, run:

```bash
npm run build:docker-{arm, x86}
```

You can then follow the instructions in [Getting Started](#getting-started), but instead use `auctioneer-bot-v{version}-{arm, x86}` as the docker image.

The bot can also be run locally with node, but you will need to invoke `start.sh` to initialize a database at `./data` and a location to place logs at `./data/logs`.
