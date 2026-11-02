import { MongoClient } from "mongodb";
import "dotenv/config";

const client = new MongoClient(process.env.MONGODB_URL);
await client.connect();

const { databases } = await client.db().admin().listDatabases();
for (const { name } of databases) {
  if (["admin", "local", "config"].includes(name)) continue;
  const db = client.db(name);
  const collections = await db.listCollections().toArray();
  const counts = {};
  for (const c of collections) {
    counts[c.name] = await db.collection(c.name).countDocuments();
  }
  console.log(name, JSON.stringify(counts));
}

await client.close();
