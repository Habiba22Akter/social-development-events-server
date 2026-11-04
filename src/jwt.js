import { createRemoteJWKSet, jwtVerify } from "jose";

import { appUrl, port } from "./config.js";

/**
 * JWT verification for the protected event API.
 *
 * BetterAuth signs every access token with an Ed25519 key and publishes the
 * matching public keys at `/api/auth/jwks`. Verifying against that JWKS means
 * this server never needs the signing secret, and key rotation keeps working
 * without a redeploy.
 *
 * The JWKS is read from the loopback address because this file runs inside the
 * Express process itself; `appUrl` is the public Next.js origin used for the
 * token's `iss` / `aud` claims.
 */
const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", `http://127.0.0.1:${port}`),
  {
    cacheMaxAge: 10 * 60 * 1000,
    timeoutDuration: 5000,
  },
);

/** Cookie that mirrors the JWT on the Next.js origin. */
export const JWT_COOKIE = "utsho.jwt";

function readCookie(cookieHeader, name) {
  if (!cookieHeader) return "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();

    if (key !== name) continue;

    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }

  return "";
}

/**
 * Prefer the standard `Authorization: Bearer <token>` header. The cookie is a
 * fallback for same-origin calls that cannot set headers (for example a plain
 * `<form>`), and both paths are verified identically.
 */
export function extractJwt(req) {
  const header = req.headers.authorization || "";
  const [scheme, ...rest] = header.trim().split(/\s+/);

  if (/^Bearer$/i.test(scheme) && rest.length) {
    return rest.join(" ");
  }

  return readCookie(req.headers.cookie, JWT_COOKIE);
}

/** Returns the verified payload, or `null` for a missing/expired/forged token. */
export async function verifyJwt(token) {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: appUrl,
      audience: appUrl,
      algorithms: ["EdDSA"],
    });

    return payload?.sub ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Attaches `req.user` when a valid JWT is present. Public routes stay public
 * (the user is simply `null`); protected routes check `req.user` themselves.
 */
export async function attachJwtUser(req, _res, next) {
  const payload = await verifyJwt(extractJwt(req));

  req.jwt = payload;
  req.user = payload
    ? {
        id: payload.sub,
        name: payload.name || "",
        email: payload.email || "",
        image: payload.image || "",
      }
    : null;

  next();
}
