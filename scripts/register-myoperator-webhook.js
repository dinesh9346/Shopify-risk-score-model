
async function registerWebhook() {
  const args = process.argv.slice(2);
  const webhookUrl = args[0];

  if (!webhookUrl) {
    console.error("Error: Please provide your webhook URL as an argument.");
    console.log("Usage: node scripts/register-myoperator-webhook.js https://your-domain.com/api/webhooks/myoperator");
    process.exit(1);
  }

  // Use the API key provided by the user
  const apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2YWNiODg2OTEyN2M4MGI3ZDJiYzNmMSIsIm5hbWUiOiJHT0RBU0ggU09MVVRJT05TIFBSSVZBVEUgTElNSVRFRCIsImFwcE5hbWUiOiJBaVNlbnN5IiwiY2xpZW50SWQiOiI2NmFjYjg4NDkxMjdjODBiN2QyYmMzODIiLCJhY3RpdmVQbGFuIjoiTk9ORSIsImlhdCI6MTcyMjU5NTQ2Mn0.W195yz9tV1TSQ5yij-6qST1GH3EJ7m1alybSzs6TU0k";
  const baseUrl = "https://backend.api-wa.co/campaign/myoperator/api/v2";

  console.log(`Attempting to register webhook: ${webhookUrl}`);
  
  // Note: The exact endpoint for webhook registration might vary depending on the provider's API version.
  // We'll try the most standard endpoints for webhook registration.
  const endpointsToTry = [
    `${baseUrl}/webhook`,
    `${baseUrl}/webhooks`,
    `${baseUrl}/webhook/subscribe`,
    `${baseUrl.replace('/v2', '')}/webhook`
  ];

  const payload = {
    apiKey: apiKey, // Some AiSensy endpoints require it in the body
    webhookUrl: webhookUrl,
    events: ["message_received", "incoming_message"] // Adjust these if you know the exact event names
  };

  let success = false;

  for (const endpoint of endpointsToTry) {
    if (success) break;

    console.log(`\nTrying endpoint: ${endpoint}`);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`, // Some APIs require Bearer
          'apiKey': apiKey // Others pass it as a header
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => null);

      if (response.ok) {
        console.log(" SUCCESS! Webhook registered successfully.");
        console.log("Response:", data);
        success = true;
      } else {
        console.log(` FAILED (Status ${response.status})`);
        if (data) console.log("Response:", data);
      }
    } catch (error) {
      console.log(` Request failed: ${error.message}`);
    }
  }

  if (!success) {
    console.log("\n=======================================================");
    console.log("If all endpoints failed, you may need to consult the exact");
    console.log("API Documentation for AiSensy / MyOperator webhook registration.");
    console.log("You can also try using cURL or Postman if the Node script fails due to environment issues.");
    console.log("=======================================================");
  }
}

registerWebhook();
