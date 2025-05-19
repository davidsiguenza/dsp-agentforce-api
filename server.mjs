import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import AWS from "aws-sdk";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// SERVIR ARCHIVOS ESTÁTICOS DESDE LA CARPETA "public"
app.use(express.static('public'));

// ------------------------------
// CONFIGURACIÓN DE AWS POLLY
// ------------------------------
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const polly = new AWS.Polly();

app.post('/synthesize', (req, res) => {
  console.log("Petición a /synthesize recibida");
  const { text, voiceId } = req.body;
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: voiceId || 'Lucia'
  };

  polly.synthesizeSpeech(params, (err, data) => {
    if (err) {
      console.error('Error en TTS:', err);
      return res.status(500).json({ error: 'Error al sintetizar el discurso' });
    }
    if (data && data.AudioStream instanceof Buffer) {
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': data.AudioStream.length
      });
      res.send(data.AudioStream);
    } else {
      res.status(500).json({ error: 'Error inesperado al generar el audio' });
    }
  });
});

// ------------------------------
// ENDPOINTS PARA INTEGRACIÓN CON SALESFORCE CHAT
// ------------------------------
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
// El AI_AGENT_ID global puede servir como fallback o ser removido si siempre se pasa desde el frontend
// const AI_AGENT_ID = process.env.AI_AGENT_ID; 

// La URL del token de Salesforce puede seguir siendo una constante o variable de entorno
const SALESFORCE_TOKEN_URL = process.env.SALESFORCE_TOKEN_URL || "https://your-salesforce-domain.my.salesforce.com/services/oauth2/token";

// Variable para almacenar tokens de acceso (podría mejorarse con un caché con expiración)
let accessToken = ""; 
// NOTA: Para múltiples agentes y sesiones, el sessionId no debe ser una variable global en el servidor
// sino que debe ser gestionado por el cliente y pasado en cada solicitud, o el servidor
// debe mantener un mapeo de sessionIds si necesita realizar acciones proactivas.
// Por simplicidad aquí, asumiremos que el cliente enviará el sessionId.

// Obtener Access Token (generalmente no es específico del agente, sino de la aplicación/org)
app.post('/get-token', async (req, res) => {
  if (accessToken) { // Si ya tenemos un token, podríamos cachearlo y reusarlo (considerar expiración)
    // return res.json({ accessToken }); 
    // Por ahora, siempre obtendremos uno nuevo para simplicidad en este ejemplo.
  }
  try {
    const { salesforceTokenUrl } = req.body; // Opcional: permitir que el cliente especifique la URL del token
    const tokenUrlToUse = salesforceTokenUrl || SALESFORCE_TOKEN_URL;

    const response = await fetch(tokenUrlToUse, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
    });
    const data = await response.json();
    if (response.ok) {
        accessToken = data.access_token; // Almacenar para futuras llamadas (considerar expiración)
        res.json({ accessToken: data.access_token });
    } else {
        console.error("Failed to get token:", data);
        res.status(response.status).json({ error: "Failed to get token", details: data });
    }
  } catch (error) {
    console.error("Error in /get-token:", error);
    res.status(500).json({ error: "Failed to get token" });
  }
});

// Iniciar sesión de chat
app.post('/start-session', async (req, res) => {
  const { aiAgentId, instanceEndpoint, externalSessionKey, salesforceApiBaseUrl } = req.body;
  
  if (!aiAgentId || !instanceEndpoint) {
    return res.status(400).json({ error: "aiAgentId and instanceEndpoint are required" });
  }
  if (!accessToken) {
      return res.status(401).json({ error: "Access token not available. Call /get-token first."});
  }

  // Construir la URL del chat dinámicamente
  const chatApiBase = salesforceApiBaseUrl || "https://api.salesforce.com"; // Permitir URL base configurable
  const salesforceChatUrl = `${chatApiBase}/einstein/ai-agent/v1/agents/${aiAgentId}/sessions`;

  try {
    const response = await fetch(salesforceChatUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        externalSessionKey: externalSessionKey || `session-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        instanceConfig: { endpoint: instanceEndpoint }, // ej: "https://your-salesforce-domain.my.salesforce.com"
        variables: [],
        streamingCapabilities: { chunkTypes: ["Text"] },
        bypassUser: true 
      })
    });
    const data = await response.json();
    if (response.ok) {
        res.json({ sessionId: data.sessionId, rawResponse: data }); // Devolver el sessionId al cliente
    } else {
        console.error("Failed to start session:", data);
        res.status(response.status).json({ error: "Failed to start session", details: data });
    }
  } catch (error) {
    console.error("Error in /start-session:", error);
    res.status(500).json({ error: "Failed to start session" });
  }
});

// Enviar mensaje al agente
app.post('/send-message', async (req, res) => {
  const { message, sessionId, aiAgentId, salesforceApiBaseUrl } = req.body; // sessionId y aiAgentId deben ser enviados por el cliente

  if (!sessionId || !message || !aiAgentId) {
    return res.status(400).json({ error: "sessionId, message, and aiAgentId are required" });
  }
   if (!accessToken) {
      return res.status(401).json({ error: "Access token not available. Call /get-token first."});
  }
  
  const chatApiBase = salesforceApiBaseUrl || "https://api.salesforce.com";
  const messagesUrl = `${chatApiBase}/einstein/ai-agent/v1/sessions/${sessionId}/messages`; // aiAgentId no es parte de esta URL específica

  try {
    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: { sequenceId: Date.now(), type: "Text", text: message.text || message }, // Adaptar si el formato de mensaje es más complejo
        variables: [] 
      })
    });
    const data = await response.json();
     if (response.ok) {
        res.json(data);
    } else {
        console.error("Failed to send message:", data);
        res.status(response.status).json({ error: "Failed to send message", details: data });
    }
  } catch (error) {
    console.error("Error in /send-message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Finalizar sesión de chat
app.delete('/end-session', async (req, res) => {
  const { sessionId, aiAgentId, salesforceApiBaseUrl } = req.body; // sessionId y aiAgentId deben ser enviados por el cliente

  if (!sessionId || !aiAgentId) {
    return res.status(400).json({ error: "sessionId and aiAgentId are required" });
  }
   if (!accessToken) {
      return res.status(401).json({ error: "Access token not available. Call /get-token first."});
  }

  const chatApiBase = salesforceApiBaseUrl || "https://api.salesforce.com";
  const sessionEndUrl = `${chatApiBase}/einstein/ai-agent/v1/sessions/${sessionId}`; // aiAgentId no es parte de esta URL específica


  try {
    const response = await fetch(sessionEndUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-session-end-reason': 'UserRequest'
      }
    });
     if (response.ok) {
        // No suele haber contenido en la respuesta de un DELETE exitoso
        res.status(204).send(); // O res.json({ message: "Session ended" });
    } else {
        const data = await response.json().catch(() => ({})); // Intenta parsear JSON, si falla, objeto vacío
        console.error("Failed to end session:", data);
        res.status(response.status).json({ error: "Failed to end session", details: data });
    }
  } catch (error) {
    console.error("Error in /end-session:", error);
    res.status(500).json({ error: "Failed to end session" });
  }
});

app.get('/', (req, res) => {
  res.send('<h1>Salesforce Chat API (Configurable) is Running</h1><p>Usa Postman o tu frontend para interactuar con la API.</p>');
});

const PORT = process.env.PORT || 3000; // Heroku asigna el puerto dinámicamente
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
