import express from "express";
import { ObjectId } from "mongodb";
import authenticateUser from "../middlewares/authenticateUser.js";
import authorizeRistoratore from "../middlewares/authorizeRistoratore.js";
import { DateTime } from "luxon";

const ordersRouter = express.Router();
const validStates = ["ordinato", "in preparazione", "consegnato"];
function calculateOrderPreparationMinutes(order) {
  if (!Array.isArray(order?.meals)) return 0;

  return order.meals.reduce((totale, meal) => {
    const quantita = Number.isFinite(meal?.quantita) ? meal.quantita : 0;
    const tempoPreparazione = Number.isFinite(meal?.tempo_preparazione) ? meal.tempo_preparazione : 10;
    return totale + (quantita * tempoPreparazione);
  }, 0);
}

ordersRouter.post("/", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;

    if (user.role !== "cliente") {
      return res.status(403).json({ error: "Solo i clienti possono creare ordini" });
    }

    const { meals } = req.body;

    if (!Array.isArray(meals) || meals.length === 0) {
      return res.status(400).json({ error: "meals deve essere un array non vuoto" });
    }

    const ordiniPerRistoranti = {};

    for (const m of meals) {
      if (!m.ristorante_id || !ObjectId.isValid(m.ristorante_id)) {
        return res.status(400).json({ error: `ristorante_id mancante o non valido per il piatto: ${m.nome}` });
      }

      const ristoranteId = new ObjectId(m.ristorante_id).toString();
      ordiniPerRistoranti[ristoranteId] = ordiniPerRistoranti[ristoranteId] || [];
      ordiniPerRistoranti[ristoranteId].push({
        _id: new ObjectId(m._id),
        nome: m.nome,
        quantita: m.quantita,
        prezzo_unitario: m.prezzo_unitario,
        prezzo_originale: m.prezzo_originale ?? null,
        in_offerta: Boolean(m.in_offerta),
        sconto_percentuale: Number(m.sconto_percentuale || 0),
        tempo_preparazione: m.tempo_preparazione || 10
      });
    }

    const utente = await db.collection("users").findOne({ _id: new ObjectId(user._id) });
    if (!utente) {
      return res.status(404).json({ error: "Utente non trovato" });
    }

    const results = await Promise.all(Object.keys(ordiniPerRistoranti).map(async (ristoranteId) => {
      let totale = 0;
      let tempoAttesa = 0;

      ordiniPerRistoranti[ristoranteId].forEach((meal) => {
        totale += meal.quantita * meal.prezzo_unitario;
        tempoAttesa += meal.quantita * meal.tempo_preparazione;
      });

      const ordiniRistorante = await db.collection("orders").find({
        ristorante_id: new ObjectId(ristoranteId),
        stato: { $ne: "consegnato" }
      }).toArray();

      const ristorante = await db.collection("restaurants").findOne({ _id: new ObjectId(ristoranteId) });
      if (!ristorante) {
        throw new Error(`Ristorante non trovato per id ${ristoranteId}`);
      }

      const stato = ordiniRistorante.length === 0 ? "in preparazione" : "ordinato";

      ordiniRistorante.forEach((o) => {
        if (["in preparazione", "ordinato"].includes(o.stato)) {
          tempoAttesa += calculateOrderPreparationMinutes(o);
        }
      });


      const newOrder = {
        cliente_id: new ObjectId(utente._id),
        cliente_nome: utente.username,
        ristorante_id: new ObjectId(ristoranteId),
        meals: ordiniPerRistoranti[ristoranteId],
        totale,
        stato,
        data_ordine: DateTime.now().setZone("Europe/Rome").toFormat("dd/MM/yyyy - HH:mm"),
        metodo_consegna: "Ritiro in Ristorante",
        tempo_attesa: tempoAttesa
      };

      const insertResult = await db.collection("orders").insertOne(newOrder);
      return { ...newOrder, _id: insertResult.insertedId };
    }));

    res.status(201).json({ message: "Ordini creati con successo.", orders: results });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Errore nella creazione dell'ordine: ${err.message}` });
  }
});

const updateOrderStatus = async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID ordine non valido" });
    }

    if (user.role !== "ristoratore") {
      return res.status(403).json({ error: "Solo i ristoratori possono modificare lo stato" });
    }

    const ristorante = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
    if (!ristorante) return res.status(404).json({ error: "Ristorante non trovato" });

    const order = await db.collection("orders").findOne({ _id: new ObjectId(id) });
    if (!order) return res.status(404).json({ error: "Ordine non trovato" });

    if (order.ristorante_id.toString() !== ristorante._id.toString()) {
      return res.status(403).json({ error: "Non puoi modificare ordini di altri ristoranti" });
    }

    const currentStateIndex = validStates.indexOf(order.stato);
    if (currentStateIndex === validStates.length - 1) {
      return res.status(400).json({ error: "Ordine già consegnato" });
    }

    const nuovoStato = validStates[currentStateIndex + 1];
    await db.collection("orders").updateOne({ _id: new ObjectId(id) }, { $set: { stato: nuovoStato } });

    res.json({ message: "Stato ordine aggiornato correttamente." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'aggiornamento ordine" });
  }
};

ordersRouter.patch("/:id/status", authenticateUser, authorizeRistoratore, updateOrderStatus);
ordersRouter.put("/:id", authenticateUser, authorizeRistoratore, updateOrderStatus);
ordersRouter.get("/", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;

    const filter = {};
    if (user.role === "cliente") {
      filter.cliente_id = new ObjectId(user._id);
    } else if (user.role === "ristoratore") {
      const ristorante = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
      if (!ristorante) return res.status(404).json({ error: "Ristorante non trovato" });

      filter.ristorante_id = new ObjectId(ristorante._id);
    } else {
      return res.status(403).json({ error: "Accesso negato" });
    }

    const orders = await db.collection("orders").find(filter).toArray();

    if (user.role === "ristoratore") {
      const ordiniConNotificaConsegna = orders
        .filter(order => order.notifica_ristoratore_consegna === true)
        .map(order => order._id);

      if (ordiniConNotificaConsegna.length > 0) {
        await db.collection("orders").updateMany(
          { _id: { $in: ordiniConNotificaConsegna } },
          { $set: { notifica_ristoratore_consegna: false } }
        );
      }
    }

    for (const order of orders) {
      const ristorante = await db.collection("restaurants").findOne({ _id: order.ristorante_id });
      order.ristorante_nome = ristorante ? ristorante.name : "Ristorante Sconosciuto";
    }

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero ordini" });
  }
});


ordersRouter.get("/:id", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID ordine non valido" });
    }

    const order = await db.collection("orders").findOne({ _id: new ObjectId(id) });

    if (!order) return res.status(404).json({ error: "Ordine non trovato" });

    if (user.role === "cliente" && order.cliente_id.toString() !== user._id) {
      return res.status(403).json({ error: "Accesso negato all'ordine" });
    }

    if (user.role === "ristoratore") {
      const ristorante = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
      if (!ristorante) {
        return res.status(404).json({ error: "Ristorante non trovato" });
      }

      if (order.ristorante_id.toString() !== ristorante._id.toString()) {
        return res.status(403).json({ error: "Accesso negato all'ordine" });
      }
    }

    if (!["cliente", "ristoratore"].includes(user.role)) {
      return res.status(403).json({ error: "Accesso negato all'ordine" });
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero ordine" });
  }
});


export default ordersRouter;
