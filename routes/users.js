import express from "express";
import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import authenticateUser from "../middlewares/authenticateUser.js";
import { validateAddressWithOpenStreetMap } from "../utils/addressValidation.js";

const usersRouter = express.Router();

function sanitizePreferenze(preferenze) {
  if (!Array.isArray(preferenze)) return [];
  return [...new Set(
    preferenze
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function sanitizeMetodoPagamento(metodoPagamento) {
  if (typeof metodoPagamento !== "string") return "";
  return metodoPagamento.trim();
}


function isValidMetodoPagamento(metodoPagamento) {
  if (typeof metodoPagamento !== "string") return false;
  const normalized = metodoPagamento.toLowerCase().trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length < 3 || normalized.length > 60) return false;

  const metodiConsentiti = [
    "revolut", "paypal", "satispay", "apple pay", "google pay", "postepay",
    "carta", "carta di credito", "carta di debito", "bancomat", "mastercard",
    "visa", "amex", "american express", "maestro"
  ];

  return metodiConsentiti.some((metodo) => normalized.includes(metodo));
}

usersRouter.get("/", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { role } = req.query;
    const filter = {};

    if (role) {
      if (!["cliente", "ristoratore"].includes(role)) {
        return res.status(400).json({ error: "role deve essere 'cliente' o 'ristoratore'" });
      }
      filter.role = role;
    }

    const users = await db.collection("users").find(
      filter,
      {
        projection: {
          password: 0
        }
      }
    ).toArray();

    res.json({ total: users.length, users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero utenti" });
  }
});

usersRouter.post("/register", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const {
      nome,
      cognome,
      username,
      email,
      password,
      numero_di_telefono,
      indirizzo = "",
      metodo_pagamento = "",
      preferenze = [],
      piva = "",
      role
    } = req.body;

    if (role === "ristoratore" && (!nome || !cognome || !username || !email || !password || !numero_di_telefono || !piva)) {
      return res.status(400).json({ error: "Nome, Cognome, Username, Email, Password, Numero di telefono e Partita IVA sono obbligatori" });
    }

    if (role === "cliente" && (!nome || !cognome || !username || !email || !password || !numero_di_telefono || !indirizzo || !metodo_pagamento)) {
      return res.status(400).json({ error: "Nome, Cognome, Username, Email, Password, Numero di telefono, Indirizzo e Metodo di Pagamento sono obbligatori" });
    }

    if (!["cliente", "ristoratore"].includes(role)) {
      return res.status(400).json({ error: "role obbligatorio e deve essere 'cliente' o 'ristoratore'" });
    }

    if (role === "cliente" && (!indirizzo || !metodo_pagamento)) {
      return res.status(400).json({ error: "Indirizzo e Metodo di Pagamento sono obbligatori" });
    }

    if (role === "cliente" && !isValidMetodoPagamento(metodo_pagamento)) {
      return res.status(400).json({ error: "Metodo di Pagamento non valido. Inserisci un metodo reale (es. Revolut, PayPal, Visa, Mastercard)." });
    }

    if (role === "cliente") {
      const addressValidation = await validateAddressWithOpenStreetMap(indirizzo);
      if (!addressValidation.valid) {
        return res.status(400).json({
          error: `Indirizzo cliente non valido. ${addressValidation.reason}`
        });
      }
    }

    if (role === "ristoratore" && !piva) {
      return res.status(400).json({ error: "Partita IVA obbligatoria" });
    }

    const userExists = await db.collection("users").findOne({
      $or: [{ username }, { email }],
    });

    if (userExists) {
      return res.status(409).json({ error: "Username o Email già in uso" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const preferenzeSanificate = sanitizePreferenze(preferenze);
    const metodoPagamentoSanificato = sanitizeMetodoPagamento(metodo_pagamento);

    let newUser={};

    if (role === "ristoratore") {
      newUser = {
        nome: nome.trim(),
        cognome: cognome.trim(),
        username,
        email,
        password: hashedPassword,
        numero_di_telefono,
        piva: piva,
        role
      };
    } else {
      newUser = {
        nome: nome.trim(),
        cognome: cognome.trim(),
        username,
        email,
        password: hashedPassword,
        numero_di_telefono,
        indirizzo,
        metodo_pagamento: metodoPagamentoSanificato,
        preferenze: preferenzeSanificate,
        role,
      };
    }

    const result = await db.collection("users").insertOne(newUser);
    res.status(201).json({ message: "Utente registrato con successo", userId: result.insertedId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella registrazione" });
  }
});

usersRouter.post("/login", async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username e Password sono obbligatori" });
    }

    const user = await db.collection("users").findOne({ username });
    if (!user) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    const token = jwt.sign(
      { userId: user._id.toString(), role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel login" });
  }
});

usersRouter.get("/me", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user._id;

    const user = await db.collection("users").findOne(
      { _id: new ObjectId(userId) },
      { projection: { password: 0 } }
    );

    if (!user) return res.status(404).json({ error: "Utente non trovato" });

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero utente" });
  }
});

usersRouter.put("/me", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user._id;
    const role = req.user.role;
    const {
      nome,
      cognome,
      username,
      email,
      numero_di_telefono,
      indirizzo = "",
      metodo_pagamento = "",
      preferenze = [],
      piva = ""
    } = req.body;

    if (role === "ristoratore" && (!nome || !cognome || !username || !email || !numero_di_telefono || !piva)) {
      return res.status(400).json({ error: "Nome, Cognome, Username, Email, Numero di telefono e Partita Iva sono obbligatori" });
    }

    if (role === "cliente" && (!nome || !cognome || !username || !email || !numero_di_telefono || !indirizzo || !metodo_pagamento)) {
      return res.status(400).json({ error: "Nome, Cognome, Username, Email, Numero di telefono, Indirizzo e Metodo di Pagamento sono obbligatori" });
    }

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: "Username non valido: usa 3-20 caratteri tra lettere, numeri e caratteri speciali" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Email non valida" });
    }

    if (!/^\+?[0-9][0-9\s-]{7,16}$/.test(numero_di_telefono)) {
      return res.status(400).json({ error: "Numero di telefono non valido" });
    }

    if (role === "cliente" && (!indirizzo || !metodo_pagamento)) {
      return res.status(400).json({ error: "Indirizzo e Metodo di Pagamento sono obbligatori" });
    }

    if (role === "cliente" && !isValidMetodoPagamento(metodo_pagamento)) {
      return res.status(400).json({ error: "Metodo di Pagamento non valido. Inserisci un metodo reale (es. Revolut, PayPal, Visa, Mastercard)." });
    }

    if (role === "cliente") {
      const addressValidation = await validateAddressWithOpenStreetMap(indirizzo);
      if (!addressValidation.valid) {
        return res.status(400).json({
          error: `Indirizzo cliente non valido. ${addressValidation.reason}`
        });
      }
    }

    if (role === "ristoratore" && !piva) {
      return res.status(400).json({ error: "Partita IVA obbligatoria" });
    }

    if (role === "ristoratore" && !/^\d{11}$/.test(piva)) {
      return res.status(400).json({ error: "Partita IVA non valida: deve contenere 11 cifre" });
    }

    if (req.body.email || req.body.username) {
      const query = {
        $or: [],
        _id: { $ne: new ObjectId(userId) },
      };
      if (req.body.email) query.$or.push({ email: req.body.email });
      if (req.body.username) query.$or.push({ username: req.body.username });

      if (query.$or.length > 0) {
        const exists = await db.collection("users").findOne(query);
        if (exists) {
          return res.status(409).json({ error: "Username o Email già in uso" });
        }
      }
    }
    const updatePayload = {
      nome: nome.trim(),
      cognome: cognome.trim(),
      username: username.trim(),
      email: email.trim(),
      numero_di_telefono: numero_di_telefono.trim()
    };

    if (role === "cliente") {
      updatePayload.indirizzo = indirizzo.trim();
      updatePayload.metodo_pagamento = sanitizeMetodoPagamento(metodo_pagamento);
      updatePayload.preferenze = sanitizePreferenze(preferenze);
    }

    if (role === "ristoratore") {
      updatePayload.piva = piva.trim();
    }

    const updatedUser = await db.collection("users").findOneAndUpdate(
      { _id: new ObjectId(userId) },
      { $set: updatePayload },
      { returnDocument: "after", projection: { password: 0 } }
    );

    if (!updatedUser) return res.status(404).json({ error: "Utente non trovato" });

    res.json(updatedUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'aggiornamento utente" });
  }
});

usersRouter.put("/me/password", authenticateUser, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user._id;
    const { oldPassword, newPassword } = req.body;
    
    const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ error: "Utente non trovato" });

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Errore durante l'analisi dei parametri" });
    }
    
    if (newPassword === oldPassword) {
      return res.status(400).json({ error: "La nuova Password deve essere diversa dalla vecchia Password" });
    }

    if (!/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(newPassword)) {
      return res.status(400).json({ error: "Nuova Password non valida: minimo 8 caratteri, almeno una lettera, un numero e un simbolo" });
    }

    const passwordMatch = await bcrypt.compare(oldPassword,user.password);
    if(!passwordMatch){
      return res.status(400).json({ error: "La Vecchia Password non corrisponde col valore indicato." });

    }

    const hashedNewPassword = await bcrypt.hash(newPassword,10);
    await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      { $set: { password: hashedNewPassword} }
    );

    res.json({ message: "Password aggiornata con successo" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nell'aggiornamento password" });
  }
});

usersRouter.delete("/me", authenticateUser, async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user._id;

  if (!ObjectId.isValid(userId)) {
    return res.status(400).json({ error: "ID utente non valido" });
  }

  try {
    if (req.user.role === "cliente") {
      await db.collection("carts").deleteOne({ user_id: new ObjectId(userId) });
      await db.collection("orders").deleteMany({
        cliente_id: new ObjectId(userId),
        stato: { $ne: "consegnato" }
      });
          }

    if (req.user.role === "ristoratore") {
      const restaurant = await db.collection("restaurants").findOne({ ristoratore_id: new ObjectId(userId) });
      if (restaurant) {
        await db.collection("orders").deleteMany({ ristorante_id: new ObjectId(restaurant._id) });
        await db.collection("restaurants").deleteOne({ _id: new ObjectId(restaurant._id) });
      }
    }

    await db.collection("users").deleteOne({ _id: new ObjectId(userId) });

    res.json({ message: "Utente eliminato correttamente e dati associati rimossi." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore durante l'eliminazione dell'utente" });
  }
});

export default usersRouter;
