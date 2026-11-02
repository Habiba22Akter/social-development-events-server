import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { appUrl, githubConfigured, googleConfigured, trustedOrigins } from "./config.js";
import { db, mongoClient } from "./db.js";

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET is missing. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  );
}

export const PASSWORD_RULE =
  "Password must be at least 6 characters and include one uppercase and one lowercase letter.";

export const passwordIsValid = (password) =>
  typeof password === "string" &&
  password.length >= 6 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password);

export const auth = betterAuth({
  appName: "Utsho",

  // The browser always talks to the Next.js app, which proxies /api/auth/* to
  // this server. So the public base URL is the Next.js origin, not :8000.
  baseURL: appUrl,
  secret: process.env.BETTER_AUTH_SECRET,

  database: mongodbAdapter(db, {
    client: mongoClient,
    // Works with standalone MongoDB and Atlas replica sets alike.
    transaction: false,
  }),

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 6,
    maxPasswordLength: 64,
    // The assignment explicitly asks us to skip email verification.
    requireEmailVerification: false,
  },

  socialProviders: {
    ...(googleConfigured
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(githubConfigured
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  user: {
    // The assignment asks for a `photoURL` field on register. BetterAuth's own
    // `image` field is filled with the same value so avatars keep working.
    additionalFields: {
      photoURL: {
        type: "string",
        required: false,
        defaultValue: "",
        input: true,
      },
    },
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },

  trustedOrigins,

  // The form validates this too; this keeps the API honest if someone posts
  // straight to /api/auth/sign-up/email.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;

      if (!passwordIsValid(ctx.body?.password)) {
        throw new APIError("BAD_REQUEST", { message: PASSWORD_RULE });
      }
    }),
  },
});

export const enabledSocialProviders = [
  ...(googleConfigured ? ["google"] : []),
  ...(githubConfigured ? ["github"] : []),
];
