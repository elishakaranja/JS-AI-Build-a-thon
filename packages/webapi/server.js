import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

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

console.log('Loaded env:', {
  hasKey: !!process.env.AZURE_OPENAI_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION
});

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Chat endpoint that interfaces with Azure OpenAI
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    console.log('Processing request:', { message: userMessage });

    const url = `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}/chat/completions`;
    
    console.log('Sending request to:', url);

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
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: userMessage }
        ],
        max_tokens: 800,
        temperature: 0.7
      },
      timeout: 30000 // 30 second timeout
    });

    console.log('Received response:', {
      status: response.status,
      hasData: !!response.data
    });

    res.json({
      reply: response.data.choices[0].message.content,
      sources: []
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