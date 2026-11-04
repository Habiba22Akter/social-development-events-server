const trimSlash = (value) => value.replace(/\/+$/, "");

/** The public URL of the Next.js app. OAuth callbacks and cookies use this. */
const configuredAppUrl = process.env.BETTER_AUTH_URL || process.env.CLIENT_URL;

if (!configuredAppUrl) {
  throw new Error("BETTER_AUTH_URL or CLIENT_URL must be configured.");
}

export const appUrl = trimSlash(configuredAppUrl);

export const port = Number(process.env.PORT || 8000);
const configuredInternalApiUrl = process.env.INTERNAL_API_URL;

if (!configuredInternalApiUrl) {
  throw new Error("INTERNAL_API_URL must be configured.");
}

export const internalApiUrl = trimSlash(configuredInternalApiUrl);

/**
 * Origins allowed to call this server directly (browser -> Express).
 * The Next.js server proxy also works, so this is only needed if the frontend
 * ever talks to the API cross-origin.
 */
export const trustedOrigins = [
  ...new Set(
    [
      appUrl,
      ...(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ].map(trimSlash),
  ),
];

export const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

export const githubConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
);
