import "dotenv/config";

import express from "express";
import { toNodeHandler } from "better-auth/node";

import { auth, enabledSocialProviders } from "./src/auth.js";
import { appUrl, port, trustedOrigins } from "./src/config.js";
import { connectToDatabase, db } from "./src/db.js";
import { eventsRouter } from "./src/events.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/*  CORS — only needed when the browser calls this server directly.            */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && trustedOrigins.includes(origin.replace(/\/+$/, ""))) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type, Authorization",
    );
    res.header("Access-Control-Max-Age", "600");
    return res.sendStatus(204);
  }

  return next();
});

/* -------------------------------------------------------------------------- */
/*  Auth — mounted before express.json() so BetterAuth gets the raw body.      */
/* -------------------------------------------------------------------------- */

const authHandler = toNodeHandler(auth);

app.all(["/api/auth", "/api/auth/*splat"], authHandler);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* -------------------------------------------------------------------------- */
/*  Events API                                                                */
/* -------------------------------------------------------------------------- */

app.use("/api/events", eventsRouter);

/* -------------------------------------------------------------------------- */
/*  Public endpoints                                                          */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    name: "Utsho API server",
    status: "ok",
    client: appUrl,
    authEndpoint: "/api/auth/*",
    eventsEndpoint: "/api/events",
    socialProviders: enabledSocialProviders,
  });
});

app.get("/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: db.databaseName });
  } catch (error) {
    res.status(503).json({ status: "error", message: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ status: "error", message: `No route for ${req.method} ${req.originalUrl}` });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  if (res.headersSent) return next(error);
  return res.status(500).json({
    status: "error",
    message: "Something went wrong on the server.",
  });
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

async function start() {
  await connectToDatabase();

  app.listen(port, () => {
    console.log(`API server running on http://localhost:${port}`);
    console.log(`Allowed origins: ${trustedOrigins.join(", ")}`);
    console.log(
      `Social providers: ${enabledSocialProviders.length ? enabledSocialProviders.join(", ") : "none configured"}`,
    );
  });
}

start().catch((error) => {
  console.error("Could not start the auth server:", error);
  process.exit(1);
});


export default app;