import express from "express";
import { MongoClient } from "mongodb";
import config from "./utils/config.js";
import usersRouter from "./routes/users.js";
import mealsRouter from "./routes/meals.js";
import restaurantsRouter from "./routes/restaurants.js";
import ordersRouter from "./routes/orders.js";
import cartsRouter from "./routes/carts.js";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ObjectId } from "mongodb";

const swaggerDocument = JSON.parse(fs.readFileSync("./documents/swagger.json", "utf-8"));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

function normalizeMealDocument(meal) {
  const normalized = { ...meal };
  if (meal?._id?.$oid && ObjectId.isValid(meal._id.$oid)) {
    normalized._id = new ObjectId(meal._id.$oid);
  } else {
    delete normalized._id;
  }
  return normalized;
}

async function bootstrapInitialMeals(db) {
  const mealsCollection = db.collection("meals");
  const mealsCount = await mealsCollection.estimatedDocumentCount();
  if (mealsCount > 0) return;

  const rawMeals = JSON.parse(fs.readFileSync("./documents/meals.json", "utf-8"));
  const normalizedMeals = Array.isArray(rawMeals) ? rawMeals.map(normalizeMealDocument) : [];
  if (normalizedMeals.length === 0) return;

  await mealsCollection.insertMany(normalizedMeals, { ordered: false });
  console.log(`Bootstrap completato: caricati ${normalizedMeals.length} piatti iniziali da documents/meals.json`);
}

async function syncGenericMealPrices(db) {
  const mealsCollection = db.collection("meals");
  const rawMeals = JSON.parse(fs.readFileSync("./documents/meals.json", "utf-8"));
  const sourceMeals = Array.isArray(rawMeals) ? rawMeals : [];

  const priceByIdMeal = new Map(
    sourceMeals
      .filter((meal) => meal?.idMeal && Number.isFinite(Number(meal.prezzo)))
      .map((meal) => [String(meal.idMeal), Number(meal.prezzo)])
  );

  if (priceByIdMeal.size === 0) return;

  const genericMeals = await mealsCollection
    .find({ ristorante_id: { $exists: false }, idMeal: { $exists: true } }, { projection: { _id: 1, idMeal: 1, prezzo: 1 } })
    .toArray();

  const updates = genericMeals
    .map((meal) => {
      const canonicalPrice = priceByIdMeal.get(String(meal.idMeal));
      if (!Number.isFinite(canonicalPrice)) return null;
      if (Number(meal.prezzo) === canonicalPrice) return null;

      return {
        updateOne: {
          filter: { _id: meal._id },
          update: { $set: { prezzo: canonicalPrice } }
        }
      };
    })
    .filter(Boolean);

  if (!updates.length) return;

  const result = await mealsCollection.bulkWrite(updates, { ordered: false });
  console.log(`Prezzi piatti generici sincronizzati da documents/meals.json: ${result.modifiedCount} aggiornati.`);
}

async function startServer() {
  try {
    const client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    app.locals.db = client.db(config.MONGODB_DB);
    await app.locals.db.command({ ping: 1 });
    await bootstrapInitialMeals(app.locals.db);
    await syncGenericMealPrices(app.locals.db);

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    app.use("/users", usersRouter);
    app.use("/meals", mealsRouter);
    app.use("/restaurants", restaurantsRouter);
    app.use("/orders", ordersRouter);
    app.use("/carts", cartsRouter);

    app.use((err, req, res, next) => {
      console.error("Errore:", err.message);
      res.status(err.status || 500).json({ error: err.message });
    });

    const PORT = config.PORT;
    app.listen(PORT, () => {
      console.log(`Server avviato su http://localhost:${PORT}`);
      console.log(`MongoDB connesso al database: ${config.MONGODB_DB}`);
    });
  } catch (err) {
    console.error("Errore durante la connessione a MongoDB:", err.message);
    process.exit(1);
  }
}

startServer();
