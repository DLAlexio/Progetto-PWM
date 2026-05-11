const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_TIMEOUT_MS = 7000;
const USER_AGENT = "FastFoodProject/1.0 (A.A.2025-2026)";

function normalizeValue(value = "") {
  return value
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function extractAddressParts(rawAddress = "") {
  const address = rawAddress.trim().replace(/\s+/g, " ");
  const chunks = address.split(",").map((part) => part.trim()).filter(Boolean);

  const capMatch = address.match(/\b\d{5}\b/);
  const cap = capMatch ? capMatch[0] : "";

  const streetChunk = chunks[0] || "";

  const cityChunkRaw = chunks.length > 1 ? chunks[chunks.length - 1] : "";
  const cityChunk = cityChunkRaw
    .replace(/\b\d{5}\b/, "")
    .replace(/\b(italia|italy)\b/i, "")
    .trim();

  const hasStreetNumber = /\b\d+[a-zA-Z]?\b/.test(streetChunk);

  return {
    address,
    chunks,
    cap,
    streetChunk,
    cityChunk,
    hasStreetNumber
  };
}

function addressMatches(parsedInput, nominatimAddress = {}) {
  const roadCandidates = [
    nominatimAddress.road,
    nominatimAddress.pedestrian,
    nominatimAddress.footway,
    nominatimAddress.cycleway,
    nominatimAddress.path,
    nominatimAddress.residential
  ].filter(Boolean);

  const normalizeStreet = (streetValue = "") => normalizeValue(
    streetValue
      .replace(/\b(via|viale|piazza|corso|largo|vicolo|strada|piazzale)\b/gi, "")
      .replace(/[.,]/g, " ")
  );

  const inputStreet = normalizeStreet(parsedInput.streetChunk);
  const inputCap = normalizeValue(parsedInput.cap);
  const inputCity = normalizeValue(parsedInput.cityChunk);

  const candidateStreet = normalizeStreet(
    roadCandidates
      .map((road) => `${road} ${(nominatimAddress.house_number || "").trim()}`.trim())
      .join(" ")
  );

  const candidateCity = normalizeValue([
    nominatimAddress.city,
    nominatimAddress.town,
    nominatimAddress.village,
    nominatimAddress.municipality,
    nominatimAddress.county
  ].filter(Boolean).join(" "));

  const candidateCap = normalizeValue(nominatimAddress.postcode || "");

  const streetMatches = inputStreet && candidateStreet && (
    candidateStreet.includes(inputStreet) || inputStreet.includes(candidateStreet)
  );

  const cityMatches = inputCity && candidateCity && (
    candidateCity.includes(inputCity) || inputCity.includes(candidateCity)
  );

  const capMatches = inputCap && candidateCap && inputCap === candidateCap;

  return streetMatches && cityMatches && capMatches;
}

export async function validateAddressWithOpenStreetMap(rawAddress, options = {}) {
  const { expectedCountryCode = "it" } = options;
  const parsedInput = extractAddressParts(rawAddress);

  if (!parsedInput.address) {
    return { valid: false, reason: "Indirizzo mancante." };
  }

  if (parsedInput.address.length < 12) {
    return { valid: false, reason: "Indirizzo troppo corto: specifica Via, Numero Civico, CAP e Città." };
  }

  if (parsedInput.chunks.length < 2 && !parsedInput.cap) {
    return { valid: false, reason: "Formato indirizzo non valido: usa almeno 'Via ... Numero, CAP Città'." };
  }

  if (!parsedInput.hasStreetNumber) {
    return { valid: false, reason: "Inserisci un Numero Civico valido nell'Indirizzo." };
  }

  if (!parsedInput.cap) {
    return { valid: false, reason: "Inserisci un CAP valido a 5 cifre nell'Indirizzo." };
  }

  if (!parsedInput.cityChunk) {
    return { valid: false, reason: "Inserisci anche la Città insieme al CAP (es. 20121 Milano)." };
  }

  const url = new URL(NOMINATIM_BASE_URL);
  url.searchParams.set("q", parsedInput.address);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", expectedCountryCode.toLowerCase());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OpenStreetMap/Nominatim non disponibile (${response.status}).`);
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      return { valid: false, reason: "Indirizzo non trovato su OpenStreetMap/Nominatim." };
    }

    const suitableResult = results.find((result) => {
      const countryCode = normalizeValue(result?.address?.country_code || "");
      if (countryCode !== expectedCountryCode.toLowerCase()) return false;
      return addressMatches(parsedInput, result.address || {});
    });

    if (!suitableResult) {
      return {
        valid: false,
        reason: "L'indirizzo esiste ma non coincide con Via, Numero Civico, CAP e Città indicati."
      };
    }

    return {
      valid: true,
      normalizedAddress: suitableResult.display_name,
      coordinates: {
        lat: parseFloat(suitableResult.lat),
        lon: parseFloat(suitableResult.lon)
      }
    };
  } catch (error) {
    return { valid: false, reason: `Errore durante la verifica dell'indirizzo: ${error.message}` };
  } finally {
    clearTimeout(timeout);
  }
}
