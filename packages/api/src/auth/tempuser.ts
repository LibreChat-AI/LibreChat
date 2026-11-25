import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

type TempTokenField = 'tempToken' | 'acknowledgementToken' | 'finalizationToken';
export type TwoFactorTempRequest = Request & {
  user?: { id?: string; _id?: { toString(): string } };
  twoFactorTokenField?: TempTokenField;
  body: Partial<Record<TempTokenField, string>>;
};

export function createTwoFactorTempUser(field: TempTokenField, env: NodeJS.ProcessEnv) {
  return (req: TwoFactorTempRequest, _res: Response, next: NextFunction): void => {
    req.twoFactorTokenField = field;
    if (req.user?.id || req.user?._id) {
      next();
      return;
    }
    const token = req.body?.[field];
    if (!token) {
      next();
      return;
    }
    try {
      const payload = jwt.verify(token, env.JWT_SECRET ?? '');
      if (typeof payload === 'object' && payload.userId) {
        req.user = { id: payload.userId };
      }
    } catch {
      // A malformed token keeps the IP quota active until the route rejects it.
    }
    next();
  };
}
