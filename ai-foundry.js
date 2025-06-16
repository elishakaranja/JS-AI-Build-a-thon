import dotenv from 'dotenv';
import ModelClient, { isUnexpected } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";

dotenv.config();

const endpoint       = process.env.AZURE_INFERENCE_SDK_ENDPOINT;
const apiKey         = process.env.AZURE_INFERENCE_SDK_KEY;
const deploymentName = "Llama-4-Maverick-17B-128E-Instruct-FP8-2"; // exact from portal

async function main() {
  const client = ModelClient(
    endpoint,
    new AzureKeyCredential(apiKey),
    { apiVersion: "2024-05-01-preview" }
  );

  const response = await client
    .path("/openai/deployments/{deploymentName}/chat/completions", deploymentName)
    .post({
      headers: { "Content-Type": "application/json" },
      body: {
        messages: [
          { role: "system", content: "You are an assistant." },
          { role: "user",   content: "Tell me a fun fact about Kenya." }
        ]
      }
    });

  if (isUnexpected(response)) {
    console.error(" Error:", response.body);
  } else {
   //console.log(" Response:", response.body);
    console.log("Response:", response.body.choices[0].message.content);

  }
}

main();
