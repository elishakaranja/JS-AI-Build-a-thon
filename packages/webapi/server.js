import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global error handlers for debugging Azure API issues
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

// Validate required Azure OpenAI configuration
function validateEnvVariables() {
  const required = [
    'AZURE_INFERENCE_SDK_ENDPOINT',
    'AZURE_INFERENCE_SDK_KEY',
    'AZURE_OPENAI_DEPLOYMENT_NAME'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Validate environment variables before creating Azure client
validateEnvVariables();

// Log environment variables (redact API key)
console.log('Loaded env:', {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
  keyFirst5: process.env.AZURE_OPENAI_KEY ? process.env.AZURE_OPENAI_KEY.slice(0, 5) + '...' : undefined
});

// PDF RAG logic
const projectRoot = path.resolve(__dirname, '../..');
const pdfPath = path.join(projectRoot, 'data/employee_handbook.pdf'); // Update with your PDF file name
let pdfText = null;
let pdfChunks = [];
const CHUNK_SIZE = 800;

async function loadPDF() {
  if (pdfText) return pdfText;
  if (!fs.existsSync(pdfPath)) return "PDF not found.";
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(dataBuffer);
  pdfText = data.text;
  let currentChunk = "";
  const words = pdfText.split(/\s+/);
  for (const word of words) {
    if ((currentChunk + " " + word).length <= CHUNK_SIZE) {
      currentChunk += (currentChunk ? " " : "") + word;
    } else {
      pdfChunks.push(currentChunk);
      currentChunk = word;
    }
  }
  if (currentChunk) pdfChunks.push(currentChunk);
  return pdfText;
}

function retrieveRelevantContent(query) {
  const queryTerms = query.toLowerCase().split(/\s+/)
    .filter(term => term.length > 3)
    .map(term => term.replace(/[.,?!;:()"']/g, ""));
  if (queryTerms.length === 0) return [];
  const scoredChunks = pdfChunks.map(chunk => {
    const chunkLower = chunk.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      const regex = new RegExp(term, 'gi');
      const matches = chunkLower.match(regex);
      if (matches) score += matches.length;
    }
    return { chunk, score };
  });
  return scoredChunks
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => item.chunk);
}

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Chat endpoint that interfaces with Azure OpenAI
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const useRAG = req.body.useRAG === undefined ? true : req.body.useRAG;
    let messages = [];
    let sources = [];
    if (useRAG) {
      await loadPDF();
      sources = retrieveRelevantContent(userMessage);
      if (sources.length > 0) {
        messages.push({
          role: "system",
          content: `You are a helpful assistant answering questions about the company based on its employee handbook.\nUse ONLY the following information from the handbook to answer the user's question.\nIf you can't find relevant information in the provided context, say so clearly.\n--- EMPLOYEE HANDBOOK EXCERPTS ---\n${sources.join('')}\n--- END OF EXCERPTS ---`
        });
      } else {
        messages.push({
          role: "system",
          content: "You are a helpful assistant. No relevant information was found in the employee handbook for this question."
        });
      }
    } else {
      messages.push({
        role: "system",
        content: "You are a helpful assistant."
      });
    }
    messages.push({ role: "user", content: userMessage });

    const url = `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}/chat/completions`;
    const response = await axios({
      method: 'post',
      url: url,
      params: {
        'api-version': process.env.AZURE_OPENAI_API_VERSION
      },
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_OPENAI_KEY
      },
      data: {
        messages,
        max_tokens: 800,
        temperature: 0.7
      },
      timeout: 30000 // 30 second timeout
    });

    res.json({
      reply: response.data.choices[0].message.content,
      sources: useRAG ? sources : []
    });
  } catch (error) {
    console.error('Chat error details:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      config: {
        url: error.config?.url,
        headers: {
          ...error.config?.headers,
          'api-key': '[REDACTED]'
        }
      }
    });

    console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

    res.status(500).json({
      error: "Failed to get response from AI",
      message: error.response?.data?.error?.message || error.message
    });
  }
});

// Server configuration and startup
const PORT = process.env.PORT || 3002;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using Azure OpenAI deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}`);
});

// Set timeout for long-running requests
server.timeout = 120000; // 2 minute timeout

// Handle server errors
server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server shutting down gracefully');
    process.exit(0);
  });
});