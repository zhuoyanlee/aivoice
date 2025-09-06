// Fixed WebSocket Handler class with proper Azure Speech integration
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
    let isFirstChunk = true; // Track first chunk per call

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Received Twilio message:', message.event);

        switch (message.event) {
          case 'start':
            callSid = message.start.callSid;
            isFirstChunk = true; // Reset for new call
            console.log(`Media stream started: ${callSid}`);

            try {
              azureSocket = await this.connectAzureWebSocket(callSid);
              console.log(`Azure WebSocket connected for call ${callSid}`);
            } catch (error) {
              console.error(`Failed to connect to Azure WebSocket for call ${callSid}:`, error);
            }
            break;

          case 'media':
            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              try {
                console.log(`Processing media chunk for call ${callSid}`);
                
                // Convert Twilio's base64 mulaw audio to PCM
                const audioData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
                const pcmData = this.convertMulawToPcm(audioData);

                // Create WAV chunk (with header for first chunk, without for subsequent)
                const wavChunk = this.createWavBuffer(pcmData, isFirstChunk);
                
                // Send to Azure
                azureSocket.send(wavChunk);
                console.log(`Sent ${wavChunk.byteLength} bytes to Azure (first chunk: ${isFirstChunk})`);
                
                isFirstChunk = false; // Only first chunk gets header
              } catch (error) {
                console.error(`Error processing media chunk for call ${callSid}:`, error);
              }
            } else {
              console.warn(`Azure WebSocket not ready for call ${callSid}. State: ${azureSocket?.readyState}`);
            }
            break;

          case 'stop':
            console.log(`Call ${callSid} ended.`);
            if (azureSocket && azureSocket.readyState === WebSocket.OPEN) {
              try {
                // Signal end of stream to Azure
                azureSocket.close(1000, 'Call ended');
              } catch (err) {
                console.error("Error closing Azure WebSocket:", err);
              }
            }
            break;

          default:
            console.log(`Unhandled Twilio event: ${message.event}`);
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    webSocket.addEventListener('close', () => {
      console.log(`Twilio WebSocket closed for call ${callSid}`);
      this.sessions.delete(webSocket);
      if (azureSocket) {
        azureSocket.close();
      }
    });

    webSocket.addEventListener('error', (error) => {
      console.error(`Twilio WebSocket error for call ${callSid}:`, error);
    });
  }

  async getAzureToken() {
    console.log(`Getting Azure token for region: ${this.env.AZURE_SPEECH_REGION}`);

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
    console.log(`Azure token obtained successfully (length: ${token.length})`);
    return token;
  }

  async connectAzureWebSocket(callSid) {
    try {
      const token = await this.getAzureToken();

      // Construct Azure WebSocket URL
      const url = `wss://${this.env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed&authorization=Bearer%20${encodeURIComponent(token)}`;
      
      console.log(`Connecting to Azure WebSocket: ${url.substring(0, 100)}...`);

      const ws = new WebSocket(url);

      // Return a promise that resolves when connection is established
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Azure WebSocket connection timeout'));
        }, 10000); // 10 second timeout

        ws.addEventListener('open', () => {
          clearTimeout(timeout);
          console.log(`✅ Azure WebSocket connected for call ${callSid}`);
          resolve(ws);
        });

        ws.addEventListener('message', async (event) => {
          try {
            console.log(`Raw Azure message: ${event.data}`);
            const data = JSON.parse(event.data);
            
            // Handle different types of Azure responses
            if (data.RecognitionStatus === "Success" && data.DisplayText) {
              const transcript = data.DisplayText;
              console.log(`🎯 Azure transcript for ${callSid}: "${transcript}"`);
              
              await this.updateCallTranscript(callSid, transcript);
              this.broadcastTranscription(callSid, transcript, 'realtime');
            } 
            else if (data.RecognitionStatus === "InitialSilenceTimeout") {
              console.log(`⏰ Initial silence timeout for call ${callSid}`);
            }
            else if (data.RecognitionStatus === "BabbleTimeout") {
              console.log(`🗣️ Babble timeout for call ${callSid}`);
            }
            else if (data.RecognitionStatus === "Error") {
              console.error(`❌ Azure recognition error for ${callSid}:`, data.ErrorDetails);
            }
            else {
              console.log(`Azure message for ${callSid}:`, data);
            }
          } catch (err) {
            console.error(`Error parsing Azure WebSocket message for ${callSid}:`, err);
            console.log(`Raw message was: ${event.data}`);
          }
        });

        ws.addEventListener('close', (event) => {
          clearTimeout(timeout);
          console.log(`🔌 Azure WebSocket closed for call ${callSid}. Code: ${event.code}, Reason: ${event.reason}`);
        });

        ws.addEventListener('error', (err) => {
          clearTimeout(timeout);
          console.error(`❌ Azure WebSocket error for ${callSid}:`, err);
          reject(err);
        });
      });
    } catch (error) {
      console.error(`Failed to connect Azure WebSocket for ${callSid}:`, error);
      throw error;
    }
  }

  // Convert mulaw to PCM for Azure Speech
  convertMulawToPcm(mulawData) {
    const pcmData = new Int16Array(mulawData.length);

    // Mulaw decode table for better performance
    const mulawTable = [
      -32124,-31100,-30076,-29052,-28028,-27004,-25980,-24956,
      -23932,-22908,-21884,-20860,-19836,-18812,-17788,-16764,
      -15996,-15484,-14972,-14460,-13948,-13436,-12924,-12412,
      -11900,-11388,-10876,-10364, -9852, -9340, -8828, -8316,
       -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
       -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
       -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
       -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
       -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
       -1372, -1308, -1244, -1180, -1116, -1052,  -988,  -924,
        -876,  -844,  -812,  -780,  -748,  -716,  -684,  -652,
        -620,  -588,  -556,  -524,  -492,  -460,  -428,  -396,
        -372,  -356,  -340,  -324,  -308,  -292,  -276,  -260,
        -244,  -228,  -212,  -196,  -180,  -164,  -148,  -132,
        -120,  -112,  -104,   -96,   -88,   -80,   -72,   -64,
         -56,   -48,   -40,   -32,   -24,   -16,    -8,     0,
       32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
       23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
       15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
       11900, 11388, 10876, 10364,  9852,  9340,  8828,  8316,
        7932,  7676,  7420,  7164,  6908,  6652,  6396,  6140,
        5884,  5628,  5372,  5116,  4860,  4604,  4348,  4092,
        3900,  3772,  3644,  3516,  3388,  3260,  3132,  3004,
        2876,  2748,  2620,  2492,  2364,  2236,  2108,  1980,
        1884,  1820,  1756,  1692,  1628,  1564,  1500,  1436,
        1372,  1308,  1244,  1180,  1116,  1052,   988,   924,
         876,   844,   812,   780,   748,   716,   684,   652,
         620,   588,   556,   524,   492,   460,   428,   396,
         372,   356,   340,   324,   308,   292,   276,   260,
         244,   228,   212,   196,   180,   164,   148,   132,
         120,   112,   104,    96,    88,    80,    72,    64,
          56,    48,    40,    32,    24,    16,     8,     0
    ];

    for (let i = 0; i < mulawData.length; i++) {
      pcmData[i] = mulawTable[mulawData[i]];
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
        console.log(`✅ Updated transcript for call ${callSid}`);
      } else {
        console.warn(`⚠️ No call data found for ${callSid}`);
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

    console.log(`📡 Broadcasting transcription to ${this.sessions.size} sessions`);
    
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