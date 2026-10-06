import { z } from 'zod';
import { moneySchema } from './money-schema.js';
import { uuidField } from './request-validation.js';

/** Body of POST /wallets (spec 9). */
export const openWalletBody = z.object(
  {
    playerId: uuidField,
    initialBalance: moneySchema,
  },
  'the body must be a JSON object',
);
