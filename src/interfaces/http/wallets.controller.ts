import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { GetWallet } from '../../application/wallets/get-wallet.js';
import { GetWalletLedger, type LedgerEntryView } from '../../application/wallets/get-wallet-ledger.js';
import { OpenWallet } from '../../application/wallets/open-wallet.js';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet.js';
import type { ReconciliationProps } from '../../domain/wallet/wallet-reconciliation.js';
import type { WalletView } from '../../application/wallets/wallet-view.js';
import { correlationIdOf } from './correlation-id.middleware.js';
import type { HttpRequest } from './http-types.js';
import { encodeLedgerCursor } from './ledger-cursor.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { parseOrThrow, uuidField } from './request-validation.js';
import { openWalletBody, parseLedgerQuery } from './wallet.request.js';

/** Body of GET /wallets/:walletId/ledger. */
export interface LedgerPageResponse {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** Pass it back as ?cursor= for the next page; null when this page reached the end. */
  readonly nextCursor: string | null;
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetWalletLedger) private readonly getWalletLedger: GetWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /** 201 created; 409 WALLET_ALREADY_EXISTS for the same player and currency. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async open(@Body() body: unknown, @Req() request: HttpRequest): Promise<WalletView> {
    const { playerId, initialBalance } = parseOrThrow(openWalletBody, body);
    return this.openWallet.execute({ playerId, initialBalance, correlationId: correlationIdOf(request) });
  }

  @Get(':walletId')
  async findOne(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.getWallet.execute(parseOrThrow(uuidField, walletId, 'walletId'));
  }

  /** 200 with a page oldest first; 400 for an invalid cursor or limit; 404 for an unknown wallet. */
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>): Promise<LedgerPageResponse> {
    const id = parseOrThrow(uuidField, walletId, 'walletId');
    const { afterVersion, limit } = parseLedgerQuery(query);
    const page = await this.getWalletLedger.execute({ walletId: id, afterVersion, limit });
    return {
      walletId: page.walletId,
      entries: page.entries,
      nextCursor: page.nextAfterVersion === undefined ? null : encodeLedgerCursor(page.nextAfterVersion),
    };
  }

  /** 200 also when the wallet diverges (consistent: false): the check itself worked. 404 for an unknown wallet. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string, @Req() request: HttpRequest): Promise<ReconciliationProps> {
    const id = parseOrThrow(uuidField, walletId, 'walletId');
    return this.reconcileWallet.execute({ walletId: id, correlationId: correlationIdOf(request) });
  }
}
