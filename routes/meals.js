import express from "express";
import { ObjectId } from "mongodb";
import authenticateUser from "../middlewares/authenticateUser.js";
import authorizeRistoratore from "../middlewares/authorizeRistoratore.js";

const mealsRouter = express.Router();

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// GET /meals - Restituisce tutti i piatti, con filtri opzionali
mealsRouter.get("/", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const {
      strCategory,
      strArea,
      nome,
      prezzoMin,
      prezzoMax,
      ristorante_id,
      ingredients,
      allergens,
      in_offerta
    } = req.query;

    const filter = {};

    if (strCategory) {
      if (Array.isArray(strCategory)) {
        filter.strCategory = { $in: strCategory.filter(Boolean) };
      } else {
        filter.strCategory = strCategory;
      }
    }
    if (strArea) filter.strArea = strArea;
    if (nome) {
      filter.strMeal = { $regex: nome, $options: "i" };
    }
    if (prezzoMin || prezzoMax) {
      filter.prezzo = {};
      if (prezzoMin) filter.prezzo.$gte = parseFloat(prezzoMin);
      if (prezzoMax) filter.prezzo.$lte = parseFloat(prezzoMax);
    }

    if (in_offerta !== undefined) {
      if (String(in_offerta) === "true") filter.in_offerta = true;
      else if (String(in_offerta) === "false") filter.in_offerta = false;
      else return res.status(400).json({ error: "in_offerta deve essere true o false" });
    }
    if (ristorante_id) {
      if (!ObjectId.isValid(ristorante_id)) {
        return res.status(400).json({ error: "ristorante_id non valido" });
      }
      filter.ristorante_id = new ObjectId(ristorante_id);
    }

    if (ingredients) {
      const ingredientsList = parseCsv(ingredients);
      filter.ingredients = {
        $all: ingredientsList.map((i) => new RegExp(`^${i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))
      };
    }

    if (allergens) {
      const allergensList = parseCsv(allergens);
      filter.ingredients = {
        ...(filter.ingredients || {}),
        $not: {
          $elemMatch: {
            $in: allergensList.map((a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
          }
        }
      };
    }

    const meals = await db.collection("meals").find(filter).toArray();

    res.json(meals);
  } catch (err) {
    res.status(500).json({ error: "Errore nel recupero dei piatti" });
  }
});



// PUT /meals/offerte - Aggiorna stato offerta per una lista di piatti del menu del ristoratore
mealsRouter.put("/offerte", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const { meal_ids, in_offerta } = req.body;

    if (!Array.isArray(meal_ids) || meal_ids.length === 0) {
      return res.status(400).json({ error: "meal_ids deve essere un array non vuoto" });
    }

    if (typeof in_offerta !== "boolean") {
      return res.status(400).json({ error: "in_offerta deve essere boolean" });
    }

    const invalidId = meal_ids.find((id) => !ObjectId.isValid(id));
    if (invalidId) {
      return res.status(400).json({ error: "Uno o più ID pasto non sono validi" });
    }

    const restaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
    if (!restaurant) {
      return res.status(404).json({ error: "Ristorante non trovato" });
    }

    const menuSet = new Set((restaurant.menu || []).map((id) => id.toString()));
    const nonAutorizzati = meal_ids.filter((id) => !menuSet.has(id));
    if (nonAutorizzati.length) {
      return res.status(403).json({ error: "Puoi aggiornare solo piatti presenti nel tuo menù" });
    }

    const objectIds = meal_ids.map((id) => new ObjectId(id));
    let update;

    if (in_offerta) {
      const meals = await db.collection("meals").find({ _id: { $in: objectIds } }).toArray();
      await Promise.all(meals.map((meal) => {
        const discount = Math.floor(Math.random() * 41) + 10;
        const basePrice = Number(meal.prezzo || 0);
        const prezzoScontato = Number((basePrice * (1 - discount / 100)).toFixed(2));
        return db.collection("meals").updateOne(
          { _id: meal._id },
          { $set: { in_offerta: true, sconto_percentuale: discount, prezzo_scontato: prezzoScontato } }
        );
      }));
    } else {
      update = await db.collection("meals").updateMany(
        { _id: { $in: objectIds } },
        { $set: { in_offerta: false, sconto_percentuale: null, prezzo_scontato: null } }
      );
    }

    return res.json({ ok: true, updated: in_offerta ? objectIds.length : update.modifiedCount });
  } catch (err) {
    return res.status(500).json({ error: "Errore nell'aggiornamento offerte" });
  }
});

// GET /meals/:id - Dettagli singolo piatto, identificato per _id
mealsRouter.get("/:id", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID non valido" });
    }

    const meal = await db.collection("meals").findOne({ _id: new ObjectId(id) });

    if (!meal) {
      return res.status(404).json({ error: "Piatto non trovato" });
    }

    res.json(meal);
  } catch (err) {
    res.status(500).json({ error: "Errore nel recupero del piatto" });
  }
});


// POST /meals - Aggiunta piatto personalizzato (Richiede autenticazione utente ristoratore)
mealsRouter.post("/", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;

    const restaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });

    if (!restaurant) {
      return res.status(403).json({ error: "Devi prima creare un ristorante per poter aggiungere piatti" });
    }

    const {
      strMeal,
      strCategory,
      strArea,
      strInstructions,
      strMealThumb,
      ingredients,
      measures,
      prezzo,
      tempo_preparazione,
      in_offerta
    } = req.body;

    if (!strMeal || typeof strMeal !== "string") {
      return res.status(400).json({ error: "strMeal richiesto e stringa" });
    }

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "ingredients deve essere un array non vuoto" });
    }

    if (!Array.isArray(measures) || measures.length !== ingredients.length) {
      return res.status(400).json({ error: "measures deve essere un array della stessa lunghezza di ingredients" });
    }

    if (typeof prezzo !== "number" || prezzo < 0) {
      return res.status(400).json({ error: "prezzo richiesto e deve essere un numero >= 0" });
    }

    if (typeof tempo_preparazione !== "number" || tempo_preparazione < 0) {
      return res.status(400).json({ error: "tempo_preparazione richiesto e deve essere un numero >= 0" });
    }

    const isInOfferta = Boolean(in_offerta);
    const randomDiscount = isInOfferta ? Math.floor(Math.random() * 41) + 10 : 0;
    const discountedPrice = isInOfferta
      ? Number((prezzo * (1 - randomDiscount / 100)).toFixed(2))
      : null;

    const newMeal = {
      strMeal,
      strCategory,
      strArea,
      strInstructions,
      strMealThumb,
      ingredients,
      measures,
      prezzo,
      tempo_preparazione,
      in_offerta: isInOfferta,
      sconto_percentuale: randomDiscount || null,
      prezzo_scontato: discountedPrice,
      ristorante_id: restaurant._id,
    };

    const result = await db.collection("meals").insertOne(newMeal);

    const restaurantUpdate = { $push: { menu: result.insertedId } };
    if (isInOfferta) {
      restaurantUpdate.$addToSet = { bacheca: result.insertedId.toString() };
    }

    await db.collection("restaurants").updateOne(
      { _id: restaurant._id },
      restaurantUpdate
    );

    res.status(201).json({ ...newMeal, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Errore nella creazione del piatto" });
  }
});



// PUT /meals/:id - Modifica piatto personalizzato (Richiede autenticazione utente ristoratore)
mealsRouter.put("/:id", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const id = req.params.id;
    let meal;

    const restaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });

    if (!restaurant) {
      return res.status(403).json({ error: "Devi prima creare un ristorante" });
    }

    if (ObjectId.isValid(id)) {
      meal = await db.collection("meals").findOne({ _id: new ObjectId(id) });
    }

    if (!meal) {
      return res.status(404).json({ error: "Piatto non trovato" });
    }

    if (!meal.ristorante_id) {
      return res.status(403).json({ error: "Impossibile modificare piatti generali" });
    }

    // un ristoratore può modificare solo i piatti personalizzati del proprio ristorante
    if (meal.ristorante_id.toString() !== restaurant._id.toString()) {
      return res.status(403).json({ error: "Accesso negato: non proprietario del piatto" });
    }

    const allowedFields = [
      "strMeal", "strCategory", "strArea", "strInstructions",
      "strMealThumb", "ingredients", "measures",
      "prezzo", "tempo_preparazione", "in_offerta", "sconto_percentuale", "prezzo_scontato"
    ];

    const updateFields = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateFields[field] = req.body[field];
      }
    }

    if ("ingredients" in updateFields && !Array.isArray(updateFields.ingredients)) {
      return res.status(400).json({ error: "ingredients deve essere un array" });
    }

    if ("measures" in updateFields && !Array.isArray(updateFields.measures)) {
      return res.status(400).json({ error: "measures deve essere un array" });
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: "Nessun campo valido da aggiornare" });
    }

    if (updateFields.in_offerta === true) {
      const discount = Math.floor(Math.random() * 41) + 10;
      const basePrice = typeof updateFields.prezzo === "number" ? updateFields.prezzo : meal.prezzo;
      updateFields.sconto_percentuale = discount;
      updateFields.prezzo_scontato = Number((basePrice * (1 - discount / 100)).toFixed(2));
    }

    if (updateFields.in_offerta === false) {
      updateFields.sconto_percentuale = null;
      updateFields.prezzo_scontato = null;
    }

    if (updateFields.prezzo !== undefined && meal.in_offerta && updateFields.in_offerta !== false) {
      const discount = typeof updateFields.sconto_percentuale === "number" ? updateFields.sconto_percentuale : meal.sconto_percentuale;
      if (typeof discount === "number") {
        updateFields.prezzo_scontato = Number((updateFields.prezzo * (1 - discount / 100)).toFixed(2));
      }
    }

    const result = await db.collection("meals").updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Piatto non trovato" });
    }

    if (updateFields.in_offerta === true) {
      await db.collection("restaurants").updateOne(
        { _id: restaurant._id },
        { $addToSet: { bacheca: id } }
      );
    }

    res.json(await db.collection("meals").findOne({ _id: new ObjectId(id) }));
  } catch (err) {
    res.status(500).json({ error: "Errore interno del server" });
  }
});


// DELETE /meals/:id - Elimina piatto personalizzato (Richiede autenticazione utente ristoratore)
mealsRouter.delete("/:id", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "ID non valido" });

    const meal = await db.collection("meals").findOne({ _id: new ObjectId(id) });

    if (!meal) return res.status(404).json({ error: "Piatto non trovato" });

    if (!meal.ristorante_id) {
      return res.status(403).json({ error: "Impossibile eliminare piatti generali" });
    }

    const restaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
    if (!restaurant) {
      return res.status(404).json({ error: "Ristorante non trovato" });
    }

    if (!user || user.role !== "ristoratore" || meal.ristorante_id.toString() !== restaurant._id.toString()) {
      return res.status(403).json({ error: "Accesso negato: non proprietario del piatto" });
    }

    const result = await db.collection("meals").deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) return res.status(404).json({ error: "Piatto non trovato" });

    await db.collection("restaurants").updateOne(
      { _id: restaurant._id },
      { $pull: { menu: new ObjectId(id) } }
    );

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: "Errore nell'eliminazione del piatto" });
  }
});

export default mealsRouter;
