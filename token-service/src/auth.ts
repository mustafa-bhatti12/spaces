import type { Request, Response, NextFunction } from 'express';

/** Service-to-service auth: the caller must present the shared secret this instance was configured with. */
export function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.TOKEN_SERVICE_SHARED_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'TOKEN_SERVICE_SHARED_SECRET is not configured.' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Invalid or missing service credentials.' });
    return;
  }
  next();
}
