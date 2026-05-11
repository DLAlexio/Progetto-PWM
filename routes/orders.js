import express from "express";
import { ObjectId } from "mongodb";
import authenticateUser from "../middlewares/authenticateUser.js";
import authorizeRistoratore from "../middlewares/authorizeRistoratore.js";
import { DateTime } from "luxon";

const ordersRouter = express.Router();
const validStates = ["ordinato", "in preparazione", "in consegna", "consegnato"];
const DELIVERY_COST_PER_KM = 0.7;
const DELIVERY_BASE_COST = 1.5;
const OSRM_TIMEOUT_MS = 7000;

async function geocodeAddress(address) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "FastFoodProject/1.0 (A.A.2025-2026)",
        "Accept": "application/json"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Errore geocoding OpenStreetMap: ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Indirizzo non trovato: ${address}`);
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon)
  };
}

function haversineKm(coord1, coord2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;

  const dLat = toRad(coord2.lat - coord1.lat);
  const dLon = toRad(coord2.lon - coord1.lon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coord1.lat)) * Math.cos(toRad(coord2.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return earthRadiusKm * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function getDrivingRouteMetrics(coordFrom, coordTo) {
  const routeUrl = new URL(
    `https://router.project-osrm.org/route/v1/driving/${coordFrom.lon},${coordFrom.lat};${coordTo.lon},${coordTo.lat}`
  );
  routeUrl.searchParams.set("overview", "false");
  routeUrl.searchParams.set("alternatives", "false");
  routeUrl.searchParams.set("steps", "false");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

  try {
    const response = await fetch(routeUrl, {
      headers: {
        "User-Agent": "FastFoodProject/1.0 (A.A.2025-2026)"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Errore routing OpenStreetMap/OSRM: ${response.status}`);
    }

    const data = await response.json();
    const firstRoute = data?.routes?.[0];

    if (!firstRoute || typeof firstRoute.distance !== "number" || typeof firstRoute.duration !== "number") {
      throw new Error("Risposta routing OSRM non valida");
    }

    return {
      distanzaKm: Number((firstRoute.distance / 1000).toFixed(2)),
      durataMin: Math.max(1, Math.ceil(firstRoute.duration / 60))
    };
  } finally {
    clearTimeout(timeout);
  }
}

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

    const { meals, metodo_consegna, indirizzo_consegna } = req.body;

    if (!Array.isArray(meals) || meals.length === 0) {
      return res.status(400).json({ error: "meals deve essere un array non vuoto" });
    }

    if (!["Ritiro in Ristorante", "Consegna a Domicilio"].includes(metodo_consegna)) {
      return res.status(400).json({ error: "metodo_consegna non valido" });
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

    if (metodo_consegna === "Consegna a Domicilio" && !(indirizzo_consegna || utente.indirizzo)) {
      return res.status(400).json({ error: "Indirizzo di consegna mancante" });
    }

    const results = await Promise.all(Object.keys(ordiniPerRistoranti).map(async (ristoranteId) => {
      let totale = 0;
      let tempoAttesa = 0;
      let costoConsegna = 0;
      let distanzaKm = 0;
      let durataConsegnaMin = 0;

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

      const indirizzoEffettivo = indirizzo_consegna || utente.indirizzo;
      if (metodo_consegna === "Consegna a Domicilio") {
        const [coordRistorante, coordConsegna] = await Promise.all([
          geocodeAddress(ristorante.address),
          geocodeAddress(indirizzoEffettivo)
        ]);

        try {
          const routeMetrics = await getDrivingRouteMetrics(coordRistorante, coordConsegna);
          distanzaKm = routeMetrics.distanzaKm;
          durataConsegnaMin = routeMetrics.durataMin;
        } catch (routingError) {
          console.warn("Routing OSRM non disponibile, fallback su distanza lineare.", routingError.message);
          distanzaKm = Number(haversineKm(coordRistorante, coordConsegna).toFixed(2));
          durataConsegnaMin = Math.max(1, Math.ceil((distanzaKm / 35) * 60));
        }

        tempoAttesa += durataConsegnaMin;
        costoConsegna = Number((DELIVERY_BASE_COST + (distanzaKm * DELIVERY_COST_PER_KM)).toFixed(2));
        totale += costoConsegna;
      }

      const newOrder = {
        cliente_id: new ObjectId(utente._id),
        cliente_nome: utente.username,
        ristorante_id: new ObjectId(ristoranteId),
        meals: ordiniPerRistoranti[ristoranteId],
        totale,
        stato,
        data_ordine: DateTime.now().setZone("Europe/Rome").toFormat("dd/MM/yyyy - HH:mm"),
        metodo_consegna,
        indirizzo_consegna: metodo_consegna === "Consegna a Domicilio" ? indirizzoEffettivo : null,
        notifica_ristoratore_consegna: false,
        distanza_km: distanzaKm,
        costo_consegna: costoConsegna,
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
    if (order.metodo_consegna === "Ritiro in Ristorante") {
      if (currentStateIndex === 3) {
        return res.status(400).json({ error: "Ordine già consegnato" });
      }
      const nuovoStato = currentStateIndex === 1 ? validStates[currentStateIndex + 2] : validStates[currentStateIndex + 1];
      await db.collection("orders").updateOne({ _id: new ObjectId(id) }, { $set: { stato: nuovoStato } });
    } else {
      if (currentStateIndex >= 2) {
        return res.status(400).json({ error: "Solo il cliente può confermare la ricezione" });
      }
      const nuovoStato = validStates[currentStateIndex + 1];
      await db.collection("orders").updateOne({ _id: new ObjectId(id) }, { $set: { stato: nuovoStato } });
    }

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

ordersRouter.put("/notifiche-consegna/ack", authenticateUser, authorizeRistoratore, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;

    if (user.role !== "ristoratore") {
      return res.status(403).json({ error: "Solo i ristoratori possono confermare le notifiche" });
    }

    const ristorante = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(user._id) });
    if (!ristorante) return res.status(404).json({ error: "Ristorante non trovato" });

    await db.collection("orders").updateMany(
      {
        ristorante_id: new ObjectId(ristorante._id),
        metodo_consegna: "Consegna a Domicilio",
        notifica_ristoratore_consegna: true
      },
      { $set: { notifica_ristoratore_consegna: false } }
    );

    res.json({ message: "Notifiche consegna confermate." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella conferma notifiche consegna" });
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

ordersRouter.put("/:id/consegna", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = req.user;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID ordine non valido" });
    }

    if (user.role !== "cliente") {
      return res.status(403).json({ error: "Solo i clienti possono confermare la consegna" });
    }

    const order = await db.collection("orders").findOne({ _id: new ObjectId(id) });

    if (!order) return res.status(404).json({ error: "Ordine non trovato" });
    if (order.cliente_id.toString() !== user._id) {
      return res.status(403).json({ error: "Non puoi modificare ordini di altri clienti" });
    }

    if (order.stato !== "in consegna") {
      return res.status(400).json({ error: "Puoi confermare la consegna solo se l'ordine è 'in consegna'" });
    }

    const updatedOrder = await db.collection("orders").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { stato: "consegnato", notifica_ristoratore_consegna: true } },
      { returnDocument: "after" }
    );

    res.json(updatedOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella conferma consegna" });
  }
});

export default ordersRouter;
