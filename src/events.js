import express from "express";
import { ObjectId } from "mongodb";

import { connectToDatabase } from "./db.js";
import { attachJwtUser } from "./jwt.js";

/**
 * Keep this list in sync with the dropdown in the Next.js app
 * (social-development-events/src/lib/site.js).
 */
const EVENT_TYPES = [
  "Cleanup",
  "Plantation",
  "Donation",
  "Education",
  "Health",
  "Food Drive",
  "Fundraiser",
];

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const DRIVE_HOSTS = new Set([
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
]);
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,}$/;

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|.*\.local|.*\.internal)$/i;

/**
 * Kept in sync with `EVENT_FALLBACK_IMAGE` in the Next.js app
 * (src/lib/image-url.js). Used when a pasted link cannot produce an image.
 */
const DEFAULT_EVENT_IMAGE =
  "https://images.pexels.com/photos/11319521/pexels-photo-11319521.jpeg?auto=compress&cs=tinysrgb&w=900";

function getDriveFileId(url) {
  if (!DRIVE_HOSTS.has(url.hostname)) return "";

  const pathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
  const candidate = pathMatch?.[1] || url.searchParams.get("id") || "";

  return DRIVE_FILE_ID.test(candidate) ? candidate : "";
}

/**
 * Mirrors social-development-events/src/lib/image-url.js. Google Drive share
 * links are viewer pages, not image files, so they are rewritten to the
 * thumbnail endpoint before they are stored.
 */
function normalizeImageUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) {
    return { url: "", error: "Add a thumbnail image URL." };
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: raw,
      error:
        "Enter a complete image URL, for example https://example.com/photo.jpg",
    };
  }

  if (parsed.protocol !== "https:") {
    return { url: raw, error: "Use an HTTPS image URL." };
  }

  const driveFileId = getDriveFileId(parsed);

  if (driveFileId) {
    return {
      url: `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w1600`,
      error: "",
    };
  }

  return { url: parsed.toString(), error: "" };
}

/**
 * Social preview images declared by a web page, in the order we prefer them.
 * Both attribute orders are covered because real pages use both.
 */
const PREVIEW_IMAGE_META = [
  /<meta[^>]+(?:property|name)=["']og:image(?::url)?["'][^>]*?content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']og:image(?::url)?["']/i,
  /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*?content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']twitter:image(?::src)?["']/i,
];

function findPreviewImage(html, pageUrl) {
  for (const pattern of PREVIEW_IMAGE_META) {
    const match = html.match(pattern);

    if (!match) continue;

    try {
      const candidate = new URL(
        match[1].replace(/&amp;/g, "&").trim(),
        pageUrl,
      );

      if (candidate.protocol === "https:") return candidate.toString();
    } catch {
      // Try the next pattern.
    }
  }

  return "";
}

/**
 * Checks that a URL really serves an image. Returns an empty string when it
 * does, otherwise a message that explains what went wrong.
 */
async function checkImageUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return "Enter a complete image URL, for example https://example.com/photo.jpg";
  }

  if (url.protocol !== "https:" || PRIVATE_HOST.test(url.hostname)) {
    return "Use a public HTTPS image URL.";
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(8000),
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    // Only the headers matter; never download the whole image.
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    if (!response.ok) {
      return `That image URL responded with ${response.status}. Check the link and try again.`;
    }

    return contentType.startsWith("image/") ? "" : "That URL does not return an image file.";
  } catch {
    return "That thumbnail URL could not be reached. Check the link and try again.";
  }
}

/**
 * Turns whatever the organiser pasted into a usable thumbnail URL.
 *
 * A direct image is used as-is. A normal web page (for example a restaurant or
 * an event page) is accepted too: its `og:image` / `twitter:image` preview is
 * extracted and stored instead, so pasting a page link still produces a real
 * thumbnail.
 */
async function resolveThumbnail(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return {
      error:
        "Enter a complete image URL, for example https://example.com/photo.jpg",
    };
  }

  if (url.protocol !== "https:" || PRIVATE_HOST.test(url.hostname)) {
    return { error: "Use a public HTTPS image URL." };
  }

  let response;

  try {
    response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "image/*,text/html" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return {
      error: "That thumbnail URL could not be reached. Check the link and try again.",
    };
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});

    return {
      error: `That thumbnail URL responded with ${response.status}. Check the link and try again.`,
    };
  }

  if (contentType.startsWith("image/")) {
    if (response.body) await response.body.cancel().catch(() => {});

    return { url: url.toString() };
  }

  if (contentType.startsWith("text/html")) {
    // Enough of the page to find the <meta> tags; never the whole site.
    const html = (await response.text()).slice(0, 400000);
    const candidate = findPreviewImage(html, response.url || url.toString());

    if (!candidate) {
      // Pages behind bot protection often ship no metadata at all. Rather than
      // blocking the organiser, keep the event and use the community photo.
      return {
        url: DEFAULT_EVENT_IMAGE,
        warning:
          "That link did not include a preview image, so a default community photo was used as the thumbnail.",
      };
    }

    const problem = await checkImageUrl(candidate);

    if (problem) {
      return {
        url: DEFAULT_EVENT_IMAGE,
        warning:
          "That page's preview image could not be used, so a default community photo was used as the thumbnail.",
      };
    }

    return { url: candidate };
  }

  if (response.body) await response.body.cancel().catch(() => {});

  return {
    error:
      "That URL does not return an image file. Paste a direct image link or a shared Google Drive file.",
  };
}

function serializeEvent(event, viewerId) {
  const participants = event.participants || [];

  return {
    _id: event._id.toString(),
    title: event.title,
    description: event.description,
    type: event.type,
    location: event.location,
    date: event.date.toISOString(),
    image: event.image,
    featured: Boolean(event.featured),
    createdAt: event.createdAt?.toISOString() ?? null,
    organizerId: event.organizerId,
    isOrganizer: Boolean(viewerId && event.organizerId === viewerId),
    participantCount: participants.length,
    joinedByViewer: Boolean(
      viewerId && participants.some((participant) => participant.userId === viewerId),
    ),
    // Names only — volunteer emails stay in the database.
    participants: participants
      .map((participant) => participant.name)
      .filter(Boolean),
  };
}

/**
 * Shared validation for creating and updating an event. Returns either
 * `{ error }` (a message safe to show the user) or `{ values }` with the
 * normalised fields that can be written to MongoDB.
 *
 * Pass the stored event as `existing` when updating: a field the organiser did
 * not change keeps its stored value, so an old event with a thumbnail that no
 * longer loads can still be edited.
 */
async function parseEventInput(body = {}, { existing = null } = {}) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const date = new Date(body.date);
  // Checkbox values arrive as "on" from FormData and as booleans from JSON.
  const featured =
    body.featured === true ||
    body.featured === "true" ||
    body.featured === "on" ||
    body.featured === 1 ||
    body.featured === "1";
  const { url: normalizedImage, error: imageError } = normalizeImageUrl(body.image);

  if (!title) return { error: "Event title is required." };
  if (title.length > 100) {
    return { error: "Event title must be 100 characters or fewer." };
  }
  if (!description) return { error: "Description is required." };
  if (description.length > 500) {
    return { error: "Description must be 500 characters or fewer." };
  }
  if (!EVENT_TYPES.includes(type)) {
    return { error: "Choose a valid event type." };
  }
  if (!location) return { error: "Meeting point is required." };
  if (location.length > 160) {
    return { error: "Meeting point must be 160 characters or fewer." };
  }
  if (imageError) return { error: imageError };
  if (!normalizedImage) return { error: "Thumbnail image URL is required." };
  if (Number.isNaN(date.getTime())) {
    return { error: "Enter a valid event date and time." };
  }

  const dateUnchanged =
    Boolean(existing?.date) &&
    date.getTime() === new Date(existing.date).getTime();

  if (!dateUnchanged && date <= new Date()) {
    return { error: "Choose a future date and time for your event." };
  }

  const imageUnchanged =
    Boolean(existing?.image) && normalizedImage === existing.image;
  let imageUrl = normalizedImage;
  let warning = "";

  if (!imageUnchanged) {
    // Accepts a direct image or a web page, in which case the page's own
    // preview image is stored as the thumbnail.
    const resolved = await resolveThumbnail(normalizedImage);

    if (resolved.error) {
      return { error: resolved.error };
    }

    imageUrl = resolved.url;
    warning = resolved.warning || "";
  }

  return {
    values: { title, description, type, location, date, image: imageUrl, featured },
    warning,
  };
}

export const eventsRouter = express.Router();

// Every route below reads the optional JWT once. Public routes stay public;
// protected routes require `req.user` (a verified token).
eventsRouter.use(attachJwtUser);

/* -------------------------------------------------------------------------- */
/*  GET /api/events — public list of upcoming events                          */
/* -------------------------------------------------------------------------- */

eventsRouter.get("/", async (req, res, next) => {
  try {
    const viewer = req.user;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 0;

    const database = await connectToDatabase();
    let cursor = database
      .collection("events")
      .find({ date: { $gte: new Date() } })
      .sort({ date: 1 });

    if (limit) cursor = cursor.limit(limit);

    const events = await cursor.toArray();

    res.json({ events: events.map((event) => serializeEvent(event, viewer?.id)) });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  POST /api/events — create (protected)                                     */
/* -------------------------------------------------------------------------- */

eventsRouter.post("/", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res
        .status(401)
        .json({ message: "You must be signed in to create an event." });
    }

    const parsed = await parseEventInput(req.body || {});

    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const event = {
      ...parsed.values,
      organizerId: user.id,
      organizerEmail: user.email,
      createdAt: new Date(),
      participants: [],
    };

    const database = await connectToDatabase();
    const result = await database.collection("events").insertOne(event);

    return res.status(201).json({
      event: serializeEvent({ ...event, _id: result.insertedId }, user.id),
      ...(parsed.warning ? { notice: parsed.warning } : {}),
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/events/mine — protected, events this user created                */
/* -------------------------------------------------------------------------- */

// Declared before "/:id" so Express does not treat "mine" as an id.
eventsRouter.get("/mine", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res
        .status(401)
        .json({ message: "Log in to manage the events you created." });
    }

    const now = new Date();
    const database = await connectToDatabase();

    const events = await database
      .collection("events")
      .aggregate([
        { $match: { organizerId: user.id } },
        { $addFields: { isPast: { $lt: ["$date", now] } } },
        { $sort: { isPast: 1, date: 1 } },
      ])
      .toArray();

    return res.json({
      events: events.map((event) => ({
        ...serializeEvent(event, user.id),
        isPast: event.isPast,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/events/joined — protected, events this user joined              */
/* -------------------------------------------------------------------------- */

// Declared before "/:id" so Express does not treat "joined" as an id.
eventsRouter.get("/joined", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res
        .status(401)
        .json({ message: "Log in to see the events you joined." });
    }

    const now = new Date();
    const database = await connectToDatabase();

    // Upcoming drives first (soonest on top), then the ones that already
    // happened. Each group is ordered by event date.
    const events = await database
      .collection("events")
      .aggregate([
        { $match: { "participants.userId": user.id } },
        { $addFields: { isPast: { $lt: ["$date", now] } } },
        { $sort: { isPast: 1, date: 1 } },
      ])
      .toArray();

    return res.json({
      events: events.map((event) => ({
        ...serializeEvent(event, user.id),
        isPast: event.isPast,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/events/featured — public home-page highlights                    */
/* -------------------------------------------------------------------------- */

// Declared before "/:id" so Express does not treat "featured" as an id.
eventsRouter.get("/featured", async (req, res, next) => {
  try {
    const viewer = req.user;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 12)
        : 3;

    const now = new Date();
    const database = await connectToDatabase();
    const events = database.collection("events");

    // Organisers can curate the section with the `featured` flag. Until they
    // do, the soonest upcoming drives fill in so the home page is never empty.
    let highlighted = await events
      .find({ date: { $gte: now }, featured: true })
      .sort({ date: 1 })
      .limit(limit)
      .toArray();

    const curated = highlighted.length > 0;

    if (!curated) {
      highlighted = await events
        .find({ date: { $gte: now } })
        .sort({ date: 1 })
        .limit(limit)
        .toArray();
    }

    return res.json({
      curated,
      events: highlighted.map((event) => serializeEvent(event, viewer?.id)),
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/events/:id — public event details                                */
/* -------------------------------------------------------------------------- */

eventsRouter.get("/:id", async (req, res, next) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(404).json({ message: "Event not found." });
    }

    const viewer = req.user;
    const database = await connectToDatabase();
    const event = await database.collection("events").findOne({
      _id: new ObjectId(req.params.id),
      date: { $gte: new Date() },
    });

    if (!event) {
      return res.status(404).json({ message: "Event not found." });
    }

    return res.json({ event: serializeEvent(event, viewer?.id) });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  POST /api/events/:id/join — protected, idempotent                         */
/* -------------------------------------------------------------------------- */

eventsRouter.post("/:id/join", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Log in to join this event." });
    }

    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(404).json({ message: "Event not found." });
    }

    const database = await connectToDatabase();
    const events = database.collection("events");
    const now = new Date();
    const eventId = new ObjectId(req.params.id);

    // The filter makes the write atomic: if this user is already in the
    // participants array (or the event has passed), nothing is pushed.
    const updated = await events.findOneAndUpdate(
      {
        _id: eventId,
        date: { $gte: now },
        "participants.userId": { $ne: user.id },
      },
      {
        $push: {
          participants: {
            userId: user.id,
            name: user.name || "",
            email: user.email,
            joinedAt: new Date(),
          },
        },
      },
      {
        returnDocument: "after",
        projection: { participants: 1 },
      },
    );

    if (updated) {
      return res.json({
        message: "You joined this event.",
        joined: true,
        alreadyJoined: false,
        participantCount: updated.participants?.length || 0,
      });
    }

    const existing = await events.findOne(
      { _id: eventId, date: { $gte: now } },
      { projection: { participants: 1 } },
    );

    if (!existing) {
      return res.status(404).json({ message: "Event not found." });
    }

    return res.json({
      message: "You already joined this event.",
      joined: true,
      alreadyJoined: true,
      participantCount: existing.participants?.length || 0,
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  PATCH /api/events/:id — protected, organiser only                         */
/* -------------------------------------------------------------------------- */

eventsRouter.patch("/:id", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Log in to update this event." });
    }

    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(404).json({ message: "Event not found." });
    }

    const database = await connectToDatabase();
    const events = database.collection("events");
    const eventId = new ObjectId(req.params.id);
    const existing = await events.findOne(
      { _id: eventId },
      { projection: { organizerId: 1, image: 1, date: 1 } },
    );

    if (!existing) {
      return res.status(404).json({ message: "Event not found." });
    }

    if (existing.organizerId !== user.id) {
      return res
        .status(403)
        .json({ message: "You can only update events you created." });
    }

    const parsed = await parseEventInput(req.body || {}, { existing });

    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const updated = await events.findOneAndUpdate(
      { _id: eventId, organizerId: user.id },
      { $set: { ...parsed.values, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!updated) {
      return res.status(404).json({ message: "Event not found." });
    }

    return res.json({
      message: "Event updated.",
      ...(parsed.warning ? { notice: parsed.warning } : {}),
      event: {
        ...serializeEvent(updated, user.id),
        isPast: updated.date < new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------------------- */
/*  DELETE /api/events/:id — protected, organiser only                        */
/* -------------------------------------------------------------------------- */

eventsRouter.delete("/:id", async (req, res, next) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Log in to delete this event." });
    }

    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(404).json({ message: "Event not found." });
    }

    const database = await connectToDatabase();
    const events = database.collection("events");
    const eventId = new ObjectId(req.params.id);
    const existing = await events.findOne(
      { _id: eventId },
      { projection: { organizerId: 1 } },
    );

    if (!existing) {
      return res.status(404).json({ message: "Event not found." });
    }

    if (existing.organizerId !== user.id) {
      return res
        .status(403)
        .json({ message: "You can only delete events you created." });
    }

    await events.deleteOne({ _id: eventId, organizerId: user.id });

    return res.json({ message: "Event deleted.", deletedId: req.params.id });
  } catch (error) {
    next(error);
  }
});
