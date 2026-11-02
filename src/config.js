const trimSlash = (value) => value.replace(/\/+$/, "");

/** The public URL of the Next.js app. OAuth callbacks and cookies use this. */
export const appUrl = trimSlash(
  process.env.BETTER_AUTH_URL ||
    process.env.CLIENT_URL ||
    "http://localhost:3000",
);

export const port = Number(process.env.PORT || 8000);

/**
 * Origins allowed to call this server directly (browser -> Express).
 * The Next.js server proxy also works, so this is only needed if the frontend
 * ever talks to the API cross-origin.
 */
export const trustedOrigins = [
  ...new Set(
    [
      appUrl,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
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
