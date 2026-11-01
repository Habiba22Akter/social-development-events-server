import express from "express";
import { MongoClient } from 'mongodb';
import 'dotenv/config'
const app = express()
const port = 8000





const client = new MongoClient(process.env.MONGODB_URL)
// , {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// });

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
///////////////
// // Call this only when your application terminates
// export async function disconnectFromMongoDB() {
//   await client.close();
// }
///////////////kete dibo ei part ta

connectToMongoDB()



app.get('/', (req, res) => {
  res.send('Server is running')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})