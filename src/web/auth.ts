import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '24h';
const COOKIE_NAME = 'actual_ai_token';

export function createToken(): string {
  return jwt.sign({ authenticated: true }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (token && verifyToken(token)) {
    next();
    return;
  }

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.redirect('/login');
}

export function loginHandler(actualPassword: string) {
  return (req: Request, res: Response): void => {
    const { password } = req.body as { password?: string };
    if (password && password === actualPassword) {
      const token = createToken();
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      });
      res.redirect('/');
      return;
    }
    res.status(401).send(loginPage('Invalid password'));
  };
}

export function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>actual-ai - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1b1d2a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: #252839; padding: 2rem; border-radius: 8px; width: 100%; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #8b7cf6; }
    label { display: block; font-size: 0.85rem; margin-bottom: 0.3rem; color: #aaa; }
    input { width: 100%; padding: 0.6rem; border: 1px solid #3a3d52; border-radius: 4px; background: #1b1d2a; color: #e0e0e0; font-size: 1rem; margin-bottom: 1rem; }
    input:focus { outline: none; border-color: #8b7cf6; }
    button { width: 100%; padding: 0.6rem; background: #8b7cf6; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #7a6be0; }
    .error { color: #f87171; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>actual-ai</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <label for="password">Actual Budget Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

export { COOKIE_NAME };
