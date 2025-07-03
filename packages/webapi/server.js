import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { fileURLToPath } from 'url';
import { AzureChatOpenAI } from "@langchain/openai";
import { BufferMemory } from "langchain/memory";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";

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
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    'AZURE_OPENAI_API_VERSION'
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
  keyFirst5: process.env.AZURE_OPENAI_API_KEY ? process.env.AZURE_OPENAI_API_KEY.slice(0, 5) + '...' : undefined
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

const sessionMemories = {};
function getSessionMemory(sessionId) {
  if (!sessionMemories[sessionId]) {
    const history = new ChatMessageHistory();
    sessionMemories[sessionId] = new BufferMemory({
      chatHistory: history,
      returnMessages: true,
      memoryKey: "chat_history",
    });
  }
  return sessionMemories[sessionId];
}

const chatModel = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_ENDPOINT.replace(/^https:\/\//, '').split('.')[0], // Extract instance name from endpoint
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
  temperature: 1,
  maxTokens: 4096,
});

// Chat endpoint that interfaces with Azure OpenAI
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const useRAG = req.body.useRAG === undefined ? true : req.body.useRAG;
  const sessionId = req.body.sessionId || "default";
  let sources = [];
  const memory = getSessionMemory(sessionId);
  const memoryVars = await memory.loadMemoryVariables({});
  if (useRAG) {
    await loadPDF();
    sources = retrieveRelevantContent(userMessage);
  }
  const systemMessage = useRAG
    ? {
        role: "system",
        content: sources.length > 0
          ? `You are a helpful assistant for Contoso Electronics. You must ONLY use the information provided below to answer.\n\n--- EMPLOYEE HANDBOOK EXCERPTS ---\n${sources.join('\n\n')}\n--- END OF EXCERPTS ---`
          : `You are a helpful assistant for Contoso Electronics. The excerpts do not contain relevant information for this question. Reply politely: \"I'm sorry, I don't know. The employee handbook does not contain information about that.\"`,
      }
    : {
        role: "system",
        content: "You are a helpful and knowledgeable assistant. Answer the user's questions concisely and informatively.",
      };
  try {
    const messages = [
      systemMessage,
      ...(memoryVars.chat_history || []),
      { role: "user", content: userMessage },
    ];
    const response = await chatModel.invoke(messages);
    await memory.saveContext({ input: userMessage }, { output: response.content });
    res.json({ reply: response.content, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Model call failed",
      message: err.message,
      reply: "Sorry, I encountered an error. Please try again."
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


