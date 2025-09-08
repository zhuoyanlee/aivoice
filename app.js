// ES Modules format for Cloudflare Workers
import { Router } from 'itty-router';

const router = Router();

// Root endpoint
router.get('/', () => {
  return new Response(JSON.stringify({
    message: 'Twilio Real-Time Voice-to-Text Backend API - Cloudflare Workers',
    endpoints: {
      '/webhook/voice': 'POST - Twilio voice webhook',
      '/webhook/recording': 'POST - Twilio recording webhook (fallback)',
      '/transcribe': 'POST - Direct transcription endpoint',
      '/call/:callSid/transcript': 'GET - Get call transcript',
      '/ws': 'WebSocket - Real-time transcription updates',
      '/health': 'GET - Health check'
    }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Twilio voice webhook - handles incoming calls
router.post('/webhook/voice', async (request, env) => {
  const formData = await request.formData();
  const callSid = formData.get('CallSid');
  const from = formData.get('From');
  const to = formData.get('To');
  const callStatus = formData.get('CallStatus');

  console.log(`Incoming call: ${callSid} from ${from} to ${to}, status: ${callStatus}`);

  // Store call data in KV
  const callData = {
    from,
    to,
    startTime: new Date().toISOString(),
    transcriptions: [],
    realtimeTranscript: '',
    status: callStatus,
    isRealTime: true
  };

  await env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));

  // Get WebSocket URL for this request
  const url = new URL(request.url);
  const wsUrl = `wss://${url.host}/ws`;

  // TwiML response with Media Stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Hello! This is Fong's Kitchen</Say>
    <Start>
        <Stream name="realtime-transcription" url="${wsUrl}" />
    </Start>
    <Say>I'm listening. Please speak, and I'll transcribe what you say in real-time.</Say>
    <Pause length="10" />
    <Record maxLength="100" playBeep="false" recordingStatusCallback="/webhook/recording" recordingStatusCallbackEvent="completed" />
    <Say>Thank you for your call.</Say>
</Response>`;

  return new Response(twiml, {
    headers: { 'Content-Type': 'text/xml' }
  });
});

// WebSocket endpoint
router.get('/ws', async (request, env) => {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  // Get Durable Object instance
  const id = env.WEBSOCKET_HANDLER.idFromName('websocket-session');
  const obj = env.WEBSOCKET_HANDLER.get(id);

  // Forward the request to the Durable Object
  return obj.fetch(request);
});

// Fallback recording webhook
router.post('/webhook/recording', async (request, env) => {
  const formData = await request.formData();
  const callSid = formData.get('CallSid');
  const recordingUrl = formData.get('RecordingUrl');
  const recordingSid = formData.get('RecordingSid');
  const recordingDuration = formData.get('RecordingDuration');

  console.log(`Recording completed for call ${callSid}: ${recordingUrl}`);

  try {
    // Get call data from KV
    const callDataStr = await env.TRANSCRIPTIONS.get(`call:${callSid}`);
    const callData = callDataStr ? JSON.parse(callDataStr) : null;

    if (callData && !callData.realtimeTranscript) {
      // Download audio from Twilio and get buffer
      const audioUrl = `${recordingUrl}.wav`;
      const audioResponse = await fetch(audioUrl, {
        headers: {
          'Authorization': `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`
        }
      });

      if (audioResponse.ok) {
        const audioBuffer = await audioResponse.arrayBuffer();

        // Store in R2 for backup (optional)
        const fileName = `recording-${recordingSid}.wav`;
        await env.AUDIO_BUCKET.put(fileName, audioBuffer);

        // Transcribe using audio buffer
        const transcript = await transcribeWithAzureAPI(null, env, audioBuffer);

        callData.transcriptions.push({
          recordingSid,
          transcript,
          duration: recordingDuration,
          timestamp: new Date().toISOString(),
          type: 'fallback',
          audioFile: fileName
        });
        callData.status = 'transcribed';

        await env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));

        console.log(`Fallback transcription completed for ${callSid}:`, transcript);
      } else {
        console.error(`Failed to download recording: ${audioResponse.statusText}`);
      }
    }
  } catch (error) {
    console.error('Error processing fallback recording:', error);
  }

  return new Response('OK');
});

// Direct transcription endpoint
router.post('/transcribe', async (request, env) => {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');

    if (!audioFile) {
      return new Response(JSON.stringify({ error: 'No audio file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Store audio in R2 bucket
    const fileName = `transcribe-${Date.now()}.wav`;
    await env.AUDIO_BUCKET.put(fileName, audioFile.stream());

    // Get signed URL for Azure Speech API
    const audioUrl = `https://your-domain.com/audio/${fileName}`;
    const transcript = await transcribeWithAzureAPI(audioUrl, env);

    // Clean up
    await env.AUDIO_BUCKET.delete(fileName);

    return new Response(JSON.stringify({
      transcript,
      filename: audioFile.name
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    return new Response(JSON.stringify({
      error: 'Transcription failed: ' + error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Get call transcript
router.get('/call/:callSid/transcript', async (request, env) => {
  const { callSid } = request.params;

  const callDataStr = await env.TRANSCRIPTIONS.get(`call:${callSid}`);
  if (!callDataStr) {
    return new Response(JSON.stringify({ error: 'Call not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const callData = JSON.parse(callDataStr);

  return new Response(JSON.stringify({
    callSid,
    ...callData
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Get all calls
router.get('/calls', async (request, env) => {
  try {
    // List all call keys from KV
    const list = await env.TRANSCRIPTIONS.list({ prefix: 'call:' });
    const calls = [];

    for (const key of list.keys) {
      const callDataStr = await env.TRANSCRIPTIONS.get(key.name);
      if (callDataStr) {
        const callData = JSON.parse(callDataStr);
        calls.push({
          callSid: key.name.replace('call:', ''),
          ...callData
        });
      }
    }

    return new Response(JSON.stringify({ calls }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Health check
router.get('/health', () => {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    platform: 'cloudflare-workers'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Azure Speech API transcription function
async function transcribeWithAzureAPI(audioUrl, env, audioBuffer = null) {
  try {
    let finalAudioBuffer;

    if (audioBuffer) {
      // Audio data already provided (for direct upload)
      finalAudioBuffer = audioBuffer;
    } else {
      // Download audio from URL (for Twilio recordings)
      const audioResponse = await fetch(audioUrl, {
        headers: {
          'Authorization': `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`
        }
      });

      if (!audioResponse.ok) {
        throw new Error('Failed to download audio');
      }

      finalAudioBuffer = await audioResponse.arrayBuffer();
    }

    // Call Azure Speech-to-Text REST API
    const speechEndpoint = `https://${env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

    const speechResponse = await fetch(speechEndpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'audio/wav',
        'Accept': 'application/json'
      },
      body: finalAudioBuffer
    });

    if (!speechResponse.ok) {
      throw new Error(`Azure Speech API error: ${speechResponse.statusText}`);
    }

    const result = await speechResponse.json();
    return result.DisplayText || result.NBest?.[0]?.Display || 'No speech detected';

  } catch (error) {
    console.error('Azure transcription error:', error);
    throw error;
  }
}

// FIXED Durable Object for WebSocket handling
export class WebSocketHandler {
  constructor(controller, env) {
    this.controller = controller;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    return await this.handleWebSocket(request);
  }

  async handleWebSocket(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(webSocket) {
    webSocket.accept();
    this.sessions.add(webSocket);

    let callSid = null;
    let azureSocket = null;
    let isFirstChunk = true;

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Twilio event:', message.event);

        switch (message.event) {
          case 'start':
            callSid = message.start.callSid;
            isFirstChunk = true;
            console.log(`Media stream started: ${callSid}`);

            try {
              azureSocket = await this.connectAzureWebSocket(callSid);
              console.log(`Azure WebSocket ready for ${callSid}`);
            } catch (error) {
              console.error(`Failed to connect Azure WebSocket: ${error.message}`);
            }
            break;

          case 'media':
            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              try {
                console.log(`Processing media chunk ${message.media.chunk} for ${callSid}`);
                
                const audioData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
                const pcmData = this.convertMulawToPcm(audioData);
                const wavChunk = this.createWavBuffer(pcmData, isFirstChunk);
                
                azureSocket.send(wavChunk);
                console.log(`Sent ${wavChunk.byteLength} bytes to Azure (first: ${isFirstChunk})`);
                
                isFirstChunk = false;
              } catch (error) {
                console.error(`Error processing media: ${error.message}`);
              }
            } else {
              console.warn(`Azure WebSocket not ready. State: ${azureSocket?.readyState}`);
            }
            break;

          case 'stop':
            console.log(`Call ${callSid} ended`);
            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              azureSocket.close(1000, 'Call ended');
            }
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error.message);
      }
    });

    webSocket.addEventListener('close', () => {
      console.log(`Twilio WebSocket closed for ${callSid}`);
      this.sessions.delete(webSocket);
      if (azureSocket) {
        azureSocket.close();
      }
    });
  }

  async getAzureToken() {
    console.log(`Getting token for region: ${this.env.AZURE_SPEECH_REGION}`);

    const resp = await fetch(`https://${this.env.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: {
        "Content-type": "application/x-www-form-urlencoded",
        "Content-length": "0", 
        "Ocp-Apim-Subscription-Key": this.env.AZURE_SPEECH_KEY
      }
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Azure token request failed: ${resp.status} - ${errorText}`);
    }
    
    const token = await resp.text();
    console.log(`Azure token obtained (${token.length} chars)`);
    return token;
  }

  async connectAzureWebSocket(callSid) {
    const token = await this.getAzureToken();
    
    // Construct the WebSocket URL
    const url = `wss://${this.env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed&authorization=Bearer%20${encodeURIComponent(token)}`;
    
    console.log(`Connecting to Azure WebSocket for ${callSid}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      
      const timeout = setTimeout(() => {
        reject(new Error('Azure WebSocket connection timeout'));
      }, 10000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        console.log(`Azure WebSocket connected for ${callSid}`);
        
        // Send configuration message
        try {
          const configMessage = JSON.stringify({
            context: {
              system: { 
                version: "1.0.00000" 
              },
              os: { 
                platform: "CloudflareWorker",
                name: "Worker",
                version: "1.0"
              },
              audio: { 
                source: "stream",
                format: "wav"
              }
            }
          });
          
          ws.send(configMessage);
          console.log(`Sent config to Azure: ${configMessage}`);
        } catch (configError) {
          console.error('Error sending config:', configError);
        }
        
        resolve(ws);
      });

      ws.addEventListener('message', async (event) => {
        try {
          console.log(`Raw Azure response: ${event.data}`);
          const data = JSON.parse(event.data);
          
          // Handle different Azure response types
          if (data.RecognitionStatus === "Success") {
            if (data.DisplayText) {
              const transcript = data.DisplayText;
              console.log(`SUCCESS: Transcript received: "${transcript}"`);
              
              await this.updateCallTranscript(callSid, transcript);
              this.broadcastTranscription(callSid, transcript, 'realtime');
            } else if (data.NBest && data.NBest[0] && data.NBest[0].Display) {
              const transcript = data.NBest[0].Display;
              console.log(`SUCCESS (NBest): Transcript received: "${transcript}"`);
              
              await this.updateCallTranscript(callSid, transcript);
              this.broadcastTranscription(callSid, transcript, 'realtime');
            }
          } else if (data.RecognitionStatus === "InitialSilenceTimeout") {
            console.log(`Initial silence timeout for ${callSid}`);
          } else if (data.RecognitionStatus === "BabbleTimeout") {
            console.log(`Babble timeout for ${callSid}`);
          } else if (data.RecognitionStatus === "Error") {
            console.error(`Azure recognition error: ${data.ErrorDetails}`);
          } else {
            // Log any other message types
            console.log(`Azure message type: ${data.RecognitionStatus || 'unknown'}`, data);
          }
        } catch (parseError) {
          console.error(`Error parsing Azure message: ${parseError.message}`);
          console.log(`Raw message was: ${event.data}`);
        }
      });

      ws.addEventListener('close', (event) => {
        clearTimeout(timeout);
        console.log(`Azure WebSocket closed for ${callSid}. Code: ${event.code}, Reason: ${event.reason}`);
      });

      ws.addEventListener('error', (error) => {
        clearTimeout(timeout);
        console.error(`Azure WebSocket error for ${callSid}:`, error);
        reject(error);
      });
    });
  }

  // Convert mulaw to PCM for Azure Speech
  convertMulawToPcm(mulawData) {
    const pcmData = new Int16Array(mulawData.length);

    for (let i = 0; i < mulawData.length; i++) {
      const mulaw = mulawData[i];
      const sign = (mulaw & 0x80) !== 0;
      const exponent = (mulaw >> 4) & 0x07;
      const mantissa = mulaw & 0x0F;

      let sample = ((mantissa << 3) + 33) << exponent;
      if (sign) sample = -sample;
      
      sample = Math.max(-32768, Math.min(32767, sample));
      pcmData[i] = sample;
    }

    return pcmData.buffer;
  }

  // Create WAV buffer for Azure Speech API
  createWavBuffer(pcmBuffer, includeHeader = false) {
    const sampleRate = 8000; // Twilio uses 8kHz
    const channels = 1;
    const bitsPerSample = 16;

    if (!includeHeader) {
      // Subsequent chunks → just raw PCM
      return pcmBuffer;
    }

    // First chunk → include WAV header
    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    // WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + pcmBuffer.byteLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true);  // AudioFormat (PCM)
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // ByteRate
    view.setUint16(32, channels * (bitsPerSample / 8), true); // BlockAlign
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, pcmBuffer.byteLength, true);

    // Combine header and data
    const wavBuffer = new ArrayBuffer(wavHeader.byteLength + pcmBuffer.byteLength);
    new Uint8Array(wavBuffer).set(new Uint8Array(wavHeader), 0);
    new Uint8Array(wavBuffer).set(new Uint8Array(pcmBuffer), wavHeader.byteLength);

    return wavBuffer;
  }

  // Update call transcript in KV storage
  async updateCallTranscript(callSid, transcript) {
    try {
      const callDataStr = await this.env.TRANSCRIPTIONS.get(`call:${callSid}`);
      if (callDataStr) {
        const callData = JSON.parse(callDataStr);
        callData.realtimeTranscript += transcript + ' ';
        callData.transcriptions.push({
          transcript,
          timestamp: new Date().toISOString(),
          type: 'realtime'
        });

        await this.env.TRANSCRIPTIONS.put(`call:${callSid}`, JSON.stringify(callData));
        console.log(`Updated transcript for ${callSid}: "${transcript}"`);
      } else {
        console.warn(`No call data found for ${callSid}`);
      }
    } catch (error) {
      console.error('Error updating call transcript:', error);
    }
  }

  broadcastTranscription(callSid, transcript, type) {
    const message = JSON.stringify({
      event: 'transcription',
      callSid,
      transcript,
      type,
      timestamp: new Date().toISOString()
    });

    console.log(`Broadcasting to ${this.sessions.size} sessions: "${transcript}"`);
    
    this.sessions.forEach(session => {
      try {
        if (session.readyState === WebSocket.OPEN) {
          session.send(message);
        }
      } catch (error) {
        console.error('Error broadcasting to session:', error);
      }
    });
  }
}

// Main fetch handler
export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  }
};

// Export the Durable Object class
export { WebSocketHandler };