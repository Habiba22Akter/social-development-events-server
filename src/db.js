import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL;

if (!uri) {
  throw new Error(
    "MONGODB_URL is missing. Copy .env.example to .env and add your MongoDB connection string.",
  );
}

export const mongoClient = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000,
});

export const db = mongoClient.db(process.env.MONGODB_DB || "utsho");

export async function connectToDatabase() {
  await mongoClient.connect();
  await db.command({ ping: 1 });
  console.log(`MongoDB connected — database "${db.databaseName}"`);
  return db;
}
