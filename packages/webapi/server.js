import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";

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

// Initialize Azure OpenAI client
const client = new ModelClient(
  process.env.AZURE_INFERENCE_SDK_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_INFERENCE_SDK_KEY)
);

// Health check endpoint for monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Chat endpoint that interfaces with Azure OpenAI
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: userMessage },
    ];

    // Construct the full path required by Azure OpenAI API
    // Format: /openai/deployments/{deployment-name}/chat/completions
    const apiPath = `/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}/chat/completions`;

    // Make the API call to Azure OpenAI
    const response = await client.path(apiPath).post({
      body: {
        messages,
        max_tokens: 4096,
        temperature: 1,
        top_p: 1,
      },
      queryParameters: {
        'api-version': '2024-05-01-preview'
      }
    });

    // Handle various response scenarios
    if (!response.body) {
      return res.status(500).json({
        error: "No response from AI model",
        details: response
      });
    }

    if (response.body.error) {
      return res.status(500).json({
        error: "Azure API error",
        message: response.body.error.message || "Unknown error"
      });
    }

    if (!response.body.choices?.[0]?.message?.content) {
      return res.status(500).json({
        error: "Invalid response structure",
        details: response.body
      });
    }

    // Send successful response
    const reply = response.body.choices[0].message.content;
    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', {
      message: err.message,
      code: err.code,
      response: err.response?.body
    });
    
    res.status(500).json({ 
      error: "Chat failed", 
      message: err.message 
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