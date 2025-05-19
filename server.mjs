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

// Endpoint para sintetizar el texto usando AWS Polly
app.post('/synthesize', (req, res) => {
  console.log("Petición a /synthesize recibida");
  const { text, voiceId } = req.body;
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: voiceId || 'Lucia' // Cambia la voz o hazlo dinámico según necesites
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
const AI_AGENT_ID = process.env.AI_AGENT_ID; 

const SALESFORCE_TOKEN_URL = "https://storm-92056ec8b1c6ce.my.salesforce.com/services/oauth2/token";
const SALESFORCE_CHAT_URL = `https://api.salesforce.com/einstein/ai-agent/v1/agents/${AI_AGENT_ID}/sessions`;

// Fallback si no está definido:
if (!AI_AGENT_ID) {
  console.error('AI_AGENT_ID not defined in .env');
}

let accessToken = "";
let sessionId = "";

// Obtener Access Token
app.post('/get-token', async (req, res) => {
  try {
    const response = await fetch(SALESFORCE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
    });
    const data = await response.json();
    accessToken = data.access_token;
    res.json({ accessToken });
  } catch (error) {
    res.status(500).json({ error: "Failed to get token" });
  }
});

// Iniciar sesión de chat
app.post('/start-session', async (req, res) => {
  try {
    const response = await fetch(SALESFORCE_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        externalSessionKey: "723a2ea4-7789-4e3f-bbd2-ea09f79d69c2",
        instanceConfig: { endpoint: "https://storm-92056ec8b1c6ce.my.salesforce.com" },
        variables: [],
        streamingCapabilities: { chunkTypes: ["Text"] },
        bypassUser: true
      })
    });
    const data = await response.json();
    sessionId = data.sessionId;
    res.json({ sessionId });
  } catch (error) {
    res.status(500).json({ error: "Failed to start session" });
  }
});

// Enviar mensaje al agente
app.post('/send-message', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await fetch(`https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: { sequenceId: Date.now(), type: "Text", text: message },
        variables: []
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Finalizar sesión de chat
app.delete('/end-session', async (req, res) => {
  try {
    await fetch(`https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-session-end-reason': 'UserRequest'
      }
    });
    sessionId = "";
    res.json({ message: "Session ended" });
  } catch (error) {
    res.status(500).json({ error: "Failed to end session" });
  }
});

// Endpoint raíz para probar el servicio
app.get('/', (req, res) => {
  res.send('<h1>Salesforce Chat API is Running</h1><p>Usa Postman o tu frontend para interactuar con la API.</p>');
});

// Iniciar el servidor
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
