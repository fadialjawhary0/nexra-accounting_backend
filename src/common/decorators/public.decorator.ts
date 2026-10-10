import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants.js';

/** Opens a route to everybody: the global auth guard (Phase 4) skips it. Use for sign-in, password reset, health. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
