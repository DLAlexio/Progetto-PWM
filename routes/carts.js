import express from "express";
import authenticateUser from "../middlewares/authenticateUser.js";
import { ObjectId } from "mongodb";

const cartsRouter = express.Router();

cartsRouter.get("/me", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      const cart = await db.collection("carts").findOne({ user_id: new ObjectId(req.user._id) });
  
      if (!cart) return res.status(404).json({ error: "Carrello vuoto o non trovato." });
  
      res.json(cart);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore nel recupero del carrello" });
    }
  });
  
cartsRouter.post("/me/items", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      const { meal_id, quantita, prezzo_unitario, prezzo_originale, in_offerta, sconto_percentuale, ristorante_id, nome } = req.body;
  
      if (!meal_id || !ObjectId.isValid(meal_id)) {
        return res.status(400).json({ error: "_id del piatto non valido" });
      }
  
      if (!ristorante_id || !ObjectId.isValid(ristorante_id)) {
        return res.status(400).json({ error: "ristorante_id non valido" });
      }
  
      let cart = await db.collection("carts").findOne({ user_id: new ObjectId(req.user._id) });
  
      if (!cart) {
        cart = { user_id: new ObjectId(req.user._id), meals: [] };
      }
  
      const mealIndex = cart.meals.findIndex(m => m._id.toString() === meal_id && m.ristorante_id.toString() === ristorante_id);
  
      if (mealIndex !== -1) {
        cart.meals[mealIndex].quantita += quantita;
        cart.meals[mealIndex].prezzo_unitario = prezzo_unitario;
        cart.meals[mealIndex].prezzo_originale = prezzo_originale ?? null;
        cart.meals[mealIndex].in_offerta = Boolean(in_offerta);
        cart.meals[mealIndex].sconto_percentuale = Number(sconto_percentuale || 0);
      } else {
        cart.meals.push({
          _id: new ObjectId(meal_id),
          nome,
          quantita,
          prezzo_unitario,
          prezzo_originale: prezzo_originale ?? null,
          in_offerta: Boolean(in_offerta),
          sconto_percentuale: Number(sconto_percentuale || 0),
          ristorante_id: new ObjectId(ristorante_id)
        });
      }
  
      await db.collection("carts").updateOne(
        { user_id: new ObjectId(req.user._id) },
        { $set: cart },
        { upsert: true }
      );
  
      res.json(cart);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore nell'aggiunta al carrello" });
    }
  });
  
cartsRouter.delete("/me/items/:mealId", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      const meal_id = req.params.mealId;
  
      if (!meal_id || !ObjectId.isValid(meal_id)) {
        return res.status(400).json({ error: "_id del piatto non valido" });
      }
  
      const cart = await db.collection("carts").findOne({ user_id: new ObjectId(req.user._id) });
  
      if (!cart || cart.meals.length === 0) {
        return res.status(404).json({ error: "Carrello vuoto o non trovato" });
      }
      
      cart.meals = cart.meals.filter(m => m._id.toString() !== meal_id);
  
      if (cart.meals.length === 0) {
        await db.collection("carts").deleteOne({ user_id: new ObjectId(req.user._id) });
        return res.json({ message: "Carrello eliminato poiché vuoto." });
      } else {
        await db.collection("carts").updateOne(
          { user_id: new ObjectId(req.user._id) },
          { $set: { meals: cart.meals } }
        );
        return res.json(cart);
      }
  
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore nella rimozione dal carrello" });
    }
  });
  
cartsRouter.delete("/me", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      await db.collection("carts").deleteOne({ user_id: new ObjectId(req.user._id) });
      res.json({ message: "Carrello eliminato correttamente." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore durante l'eliminazione del carrello" });
    }
  });

cartsRouter.put("/add", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      const { meal_id, quantita, prezzo_unitario, prezzo_originale, in_offerta, sconto_percentuale, ristorante_id, nome } = req.body;

      if (!meal_id || !ObjectId.isValid(meal_id)) {
        return res.status(400).json({ error: "_id del piatto non valido" });
      }

      if (!ristorante_id || !ObjectId.isValid(ristorante_id)) {
        return res.status(400).json({ error: "ristorante_id non valido" });
      }

      let cart = await db.collection("carts").findOne({ user_id: new ObjectId(req.user._id) });
      if (!cart) cart = { user_id: new ObjectId(req.user._id), meals: [] };

      const mealIndex = cart.meals.findIndex(m => m._id.toString() === meal_id && m.ristorante_id.toString() === ristorante_id);
      if (mealIndex !== -1) {
        cart.meals[mealIndex].quantita += quantita;
        cart.meals[mealIndex].prezzo_unitario = prezzo_unitario;
        cart.meals[mealIndex].prezzo_originale = prezzo_originale ?? null;
        cart.meals[mealIndex].in_offerta = Boolean(in_offerta);
        cart.meals[mealIndex].sconto_percentuale = Number(sconto_percentuale || 0);
      } else {
        cart.meals.push({ _id: new ObjectId(meal_id), nome, quantita, prezzo_unitario, prezzo_originale: prezzo_originale ?? null, in_offerta: Boolean(in_offerta), sconto_percentuale: Number(sconto_percentuale || 0), ristorante_id: new ObjectId(ristorante_id) });
      }

      await db.collection("carts").updateOne({ user_id: new ObjectId(req.user._id) }, { $set: cart }, { upsert: true });
      res.json(cart);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore nell'aggiunta al carrello" });
    }
  });

cartsRouter.put("/remove", authenticateUser, async (req, res) => {
    try {
      const db = req.app.locals.db;
      const { meal_id } = req.body;
      if (!meal_id || !ObjectId.isValid(meal_id)) return res.status(400).json({ error: "_id del piatto non valido" });
      const cart = await db.collection("carts").findOne({ user_id: new ObjectId(req.user._id) });
      if (!cart || cart.meals.length === 0) return res.status(404).json({ error: "Carrello vuoto o non trovato" });
      cart.meals = cart.meals.filter(m => m._id.toString() !== meal_id);
      if (cart.meals.length === 0) {
        await db.collection("carts").deleteOne({ user_id: new ObjectId(req.user._id) });
        return res.json({ message: "Carrello eliminato poiché vuoto." });
      }
      await db.collection("carts").updateOne({ user_id: new ObjectId(req.user._id) }, { $set: { meals: cart.meals } });
      return res.json(cart);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Errore nella rimozione dal carrello" });
    }
  });

  export default cartsRouter;
