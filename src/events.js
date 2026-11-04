import express from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";

import { auth } from "./auth.js";
import { connectToDatabase } from "./db.js";

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

async function isLoadableImageUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || PRIVATE_HOST.test(url.hostname)) {
    return false;
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

    return response.ok && contentType.startsWith("image/");
  } catch {
    return false;
  }
}

async function getSessionUser(req) {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    return session?.user || null;
  } catch {
    return null;
  }
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
  const { url: imageUrl, error: imageError } = normalizeImageUrl(body.image);

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
  if (!imageUrl) return { error: "Thumbnail image URL is required." };
  if (Number.isNaN(date.getTime())) {
    return { error: "Enter a valid event date and time." };
  }

  const dateUnchanged =
    Boolean(existing?.date) &&
    date.getTime() === new Date(existing.date).getTime();

  if (!dateUnchanged && date <= new Date()) {
    return { error: "Choose a future date and time for your event." };
  }

  const imageUnchanged = Boolean(existing?.image) && imageUrl === existing.image;

  if (!imageUnchanged && !(await isLoadableImageUrl(imageUrl))) {
    return {
      error:
        "That thumbnail URL does not load as an image. Paste a direct image link (for example https://example.com/photo.jpg) or a shared Google Drive link.",
    };
  }

  return { values: { title, description, type, location, date, image: imageUrl } };
}

export const eventsRouter = express.Router();

/* -------------------------------------------------------------------------- */
/*  GET /api/events — public list of upcoming events                          */
/* -------------------------------------------------------------------------- */

eventsRouter.get("/", async (req, res, next) => {
  try {
    const viewer = await getSessionUser(req);
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
    const user = await getSessionUser(req);

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
    const user = await getSessionUser(req);

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
    const user = await getSessionUser(req);

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
/*  GET /api/events/:id — public event details                                */
/* -------------------------------------------------------------------------- */

eventsRouter.get("/:id", async (req, res, next) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) {
      return res.status(404).json({ message: "Event not found." });
    }

    const viewer = await getSessionUser(req);
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
    const user = await getSessionUser(req);

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
    const user = await getSessionUser(req);

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
    const user = await getSessionUser(req);

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
