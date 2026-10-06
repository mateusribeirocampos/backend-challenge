import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { GetWallet } from '../../application/wallets/get-wallet.js';
import { OpenWallet } from '../../application/wallets/open-wallet.js';
import type { WalletView } from '../../application/wallets/wallet-view.js';
import { correlationIdOf } from './correlation-id.middleware.js';
import type { HttpRequest } from './http-types.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { parseOrThrow, uuidField } from './request-validation.js';
import { openWalletBody } from './wallet.request.js';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
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
}
