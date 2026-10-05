import type { Request, Response, RequestHandler } from 'express';

/** Wait for middleware admission or a terminal response, releasing listeners on every outcome. */
export async function admitRequestMiddleware(
  req: Request,
  res: Response,
  middleware: readonly RequestHandler[],
): Promise<boolean> {
  for (const handler of middleware) {
    const admitted = await new Promise<boolean>((resolve, reject) => {
      const finish = () => settle(false);
      const settle = (allowed: boolean, error?: unknown) => {
        res.off('finish', finish);
        res.off('close', finish);
        if (error) reject(error);
        else resolve(allowed);
      };
      if (res.writableEnded || res.destroyed) return settle(false);
      res.once('finish', finish);
      res.once('close', finish);
      try {
        Promise.resolve(handler(req, res, (error) => settle(!error, error))).catch((error) =>
          settle(false, error),
        );
      } catch (error) {
        settle(false, error);
      }
    });
    if (!admitted) return false;
  }
  return !res.writableEnded && !res.destroyed;
}
