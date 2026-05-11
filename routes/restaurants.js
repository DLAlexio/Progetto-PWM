import express from "express";
import { ObjectId } from "mongodb";
import authenticateUser from "../middlewares/authenticateUser.js";
import authorizeRistoratore from "../middlewares/authorizeRistoratore.js";
import { validateAddressWithOpenStreetMap } from "../utils/addressValidation.js";

const router = express.Router();

function parseOrderDateToDate(rawValue) {
  if (!rawValue) return null;

  const normalized = String(rawValue).trim();
  const italianPattern = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{2}):(\d{2}))?$/);

  if (italianPattern) {
    const day = Number(italianPattern[1]);
    const month = Number(italianPattern[2]) - 1;
    const year = Number(italianPattern[3]);
    const hour = Number(italianPattern[4] || 0);
    const minute = Number(italianPattern[5] || 0);
    return new Date(year, month, day, hour, minute);
  }

  const genericDate = new Date(normalized);
  return Number.isNaN(genericDate.getTime()) ? null : genericDate;
}

function getYyyyMmDd(dateValue) {
  return dateValue.toISOString().slice(0, 10);
}

router.get("/search", async (req, res) => {
  const db = req.app.locals.db;
  const { q, address } = req.query;

  const filter = {};

  if (q) {
    filter.name = { $regex: q, $options: "i" };
  }

  if (address) {
    filter.address = { $regex: address, $options: "i" };
  }

  try {
    const restaurants = await db.collection("restaurants")
      .find(filter)
      .toArray();

    res.json({ total: restaurants.length, restaurants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella ricerca ristoranti" });
  }
});

router.get("/by-meal", async (req, res) => {
  const db = req.app.locals.db;
  const { meal } = req.query;

  if (!meal) {
    return res.status(400).json({ error: "Parametro 'meal' obbligatorio" });
  }

  try {
    const meals = await db.collection("meals").find({
      strMeal: { $regex: meal, $options: "i" }
    }, { projection: { _id: 1, strMeal: 1, ristorante_id: 1 } }).toArray();

    if (meals.length === 0) {
      return res.json({ total: 0, restaurants: [] });
    }

    const restaurantIds = [...new Set(meals
      .map((m) => m.ristorante_id)
      .filter(Boolean)
      .map((id) => id.toString()))]
      .map((id) => new ObjectId(id));

    const restaurants = await db.collection("restaurants").find({ _id: { $in: restaurantIds } }).toArray();

    const mealsByRestaurant = meals.reduce((acc, m) => {
      if (!m.ristorante_id) return acc;
      const key = m.ristorante_id.toString();
      acc[key] = acc[key] || [];
      acc[key].push({ _id: m._id, strMeal: m.strMeal });
      return acc;
    }, {});

    const enrichedRestaurants = restaurants.map((r) => ({
      ...r,
      matchingMeals: mealsByRestaurant[r._id.toString()] || []
    }));

    res.json({ total: enrichedRestaurants.length, restaurants: enrichedRestaurants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella ricerca ristoranti per piatto" });
  }
});

router.get("/", async (req, res) => {
  const db = req.app.locals.db;
  try {
    const restaurants = await db.collection("restaurants").find({}).toArray();
    res.json(restaurants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero dei ristoranti" });
  }
});

router.get("/statistics", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;

    const ristorante = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });

    if (!ristorante) {
      return res.status(404).json({ error: "Ristorante non trovato" });
    }

    const orders = await db.collection("orders").find({ ristorante_id: new ObjectId(ristorante._id) }).toArray();
    const deliveredOrders = orders.filter((order) => order.stato === "consegnato");

    const totalOrders = orders.length;
    const totalDeliveredOrders = deliveredOrders.length;
    let totalRevenue = 0;
    let deliveredRevenue = 0;
    let ordersByState = {};
    let mealCount = {};
    let ordersTrend = {};
    const statusOrder = ["ordinato", "in preparazione", "in consegna", "consegnato"];

    orders.forEach(({ totale, stato, meals, data_ordine }) => {
      const orderTotal = Number(totale) || 0;
      totalRevenue += orderTotal;
      ordersByState[stato] = (ordersByState[stato] || 0) + 1;
      if (stato === "consegnato") {
        deliveredRevenue += orderTotal;
      }

      if (Array.isArray(meals)) {
        meals.forEach(({ nome, quantita }) => {
          if (!nome) return;
          mealCount[nome] = (mealCount[nome] || 0) + (Number(quantita) || 0);
        });
      }

      const parsedDate = parseOrderDateToDate(data_ordine);
      if (!parsedDate) return;
      const dateKey = getYyyyMmDd(parsedDate);
      ordersTrend[dateKey] = (ordersTrend[dateKey] || 0) + 1;
    });

    statusOrder.forEach((status) => {
      ordersByState[status] = ordersByState[status] || 0;
    });

    const ordersTrendLast30Days = Object.entries(ordersTrend)
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-30)
      .reduce((acc, [date, count]) => {
        acc[date] = count;
        return acc;
      }, {});

    res.json({
      totalOrders,
      totalDeliveredOrders,
      totalRevenue,
      deliveredRevenue,
      ordersByState,
      topMeals: Object.entries(mealCount).sort((a, b) => b[1] - a[1]).slice(0, 5),
      ordersTrend: ordersTrendLast30Days
    });

  } catch (err) {
    res.status(500).json({ error: "Errore nel recupero delle statistiche" });
  }
});

router.get("/:restaurantId", async (req, res) => {
  const db = req.app.locals.db;
  const restaurantId = req.params.restaurantId;

  if (!ObjectId.isValid(restaurantId)) {
    return res.status(400).json({ error: "ID ristorante non valido" });
  }

  try {
    const restaurant = await db.collection("restaurants").findOne({ _id: new ObjectId(restaurantId) });
    if (!restaurant) {
      return res.status(404).json({ error: "Ristorante non trovato" });
    }
    const mealIds = Array.isArray(restaurant.menu) 
    ? restaurant.menu.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id))
    : [];
    const meals = await db.collection("meals").find({ _id: { $in: mealIds } }).toArray();

    res.json({ ...restaurant, meals: meals });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero del ristorante" });
  }
});

router.post("/", authenticateUser, authorizeRistoratore, async (req, res) => {
  const db = req.app.locals.db;
  const user = req.user;
  const { name, address, numero_di_telefono, piva, menu, bacheca = [], description, image } = req.body;
  if (!name || !address || !numero_di_telefono) {
    return res.status(400).json({ error: "Nome, Indirizzo e Numero di Telefono sono obbligatori" });
  }

  const addressValidation = await validateAddressWithOpenStreetMap(address);
  if (!addressValidation.valid) {
    return res.status(400).json({
      error: `Indirizzo ristorante non valido. ${addressValidation.reason}`
    });
  }

  try {
    const existingRestaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
    if (existingRestaurant) {
      return res.status(400).json({ error: "Hai già un ristorante associato" });
    }

    const ristoratore = await db.collection("users").findOne({ _id: new ObjectId(user._id) });
    const partitaIva = piva || ristoratore?.piva;
    if (!partitaIva) {
      return res.status(400).json({ error: "Partita IVA obbligatoria per creare un Ristorante" });
    }

    const newRestaurant = {
      name,
      address,
      numero_di_telefono,
      piva: partitaIva,
      description,
      image,
      menu,
      bacheca: Array.isArray(bacheca) ? bacheca : [],
      ristoratore_id: new ObjectId(user._id)
    };

    const result = await db.collection("restaurants").insertOne(newRestaurant);
    res.status(201).json({ ...newRestaurant, _id: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella creazione del ristorante" });
  }
});

router.put("/:restaurantId", authenticateUser, authorizeRistoratore, async (req, res) => {
  const db = req.app.locals.db;
  const user = req.user;
  const restaurantId = req.params.restaurantId;
  const { name, address, numero_di_telefono, piva, menu, bacheca, description, image } = req.body;
  if (!ObjectId.isValid(restaurantId)) {
    return res.status(400).json({ error: "ID ristorante non valido" });
  }

  if (bacheca !== undefined && !Array.isArray(bacheca)) {
    return res.status(400).json({ error: "Bacheca deve essere un array" });
  }

  try {
    const restaurant = await db.collection("restaurants").findOne({ _id: new ObjectId(restaurantId) });
    if (!restaurant) {
      return res.status(404).json({ error: "Ristorante non trovato" });
    }

    if (restaurant.ristoratore_id.toString() !== user._id.toString()) {
      return res.status(403).json({ error: "Accesso negato: non proprietario del ristorante" });
    }

    const updateDoc={};

    if (name) updateDoc.name = name;
    if (address) {
      const addressValidation = await validateAddressWithOpenStreetMap(address);
      if (!addressValidation.valid) {
        return res.status(400).json({
          error: `Indirizzo ristorante non valido. ${addressValidation.reason}`
        });
      }
      updateDoc.address = address;
    }
    if (numero_di_telefono) updateDoc.numero_di_telefono = numero_di_telefono;
    if (piva) updateDoc.piva = piva;
    if (menu) updateDoc.menu = menu;
    if (Array.isArray(bacheca)) updateDoc.bacheca = bacheca;
    if (description) updateDoc.description = description;
    if (image) updateDoc.image = image;

    await db.collection("restaurants").updateOne(
      { _id: new ObjectId(restaurantId) },
      { $set: updateDoc }
    );

    const updatedRestaurant = await db.collection("restaurants").findOne({ _id: new ObjectId(restaurantId) });
    res.json(updatedRestaurant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella modifica del ristorante" });
  }
});

router.delete("/:restaurantId", authenticateUser, authorizeRistoratore, async (req, res) => {
  const db = req.app.locals.db;
  const user = req.user;
  const restaurantId = req.params.restaurantId;

  if (!ObjectId.isValid(restaurantId)) {
    return res.status(400).json({ error: "ID ristorante non valido" });
  }

  try {
    const restaurant = await db.collection("restaurants").findOne({ _id: new ObjectId(restaurantId), ristoratore_id: new ObjectId(user._id) });
    
    if (!restaurant) {
      return res.status(403).json({ error: "Non puoi eliminare un ristorante che non ti appartiene" });
    }

    await db.collection("meals").deleteMany({ ristorante_id: new ObjectId(restaurantId) });

    await db.collection("orders").deleteMany({ ristorante_id: new ObjectId(restaurantId) });

    await db.collection("restaurants").deleteOne({ _id: new ObjectId(restaurantId) });

    res.json({ message: "Ristorante, piatti e ordini eliminati correttamente." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella cancellazione del ristorante" });
  }
});

export default router;
