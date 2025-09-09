// Fixed Durable Object for WebSocket handling
class WebSocketHandler {
  constructor(controller, env) {
    this.controller = controller;
    this.env = env;
    this.sessions = new Set();
    this.pushStreams = new Map();
    this.recognizers = new Map();
    this.audioBuffers = new Map();
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
    let recognizer = null;
    let pushStream = null;
    let audioFormat = null;

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Twilio event:', message.event);

        switch (message.event) {
          case 'start':
            callSid = message.start.callSid;
            audioFormat = message.start.mediaFormat;
            this.audioBuffers.set(callSid, []);
            console.log(`Media stream started: ${callSid}, format: ${JSON.stringify(audioFormat)}`);

            try {
              const result = await this.setupAzureRecognizer(callSid);
              recognizer = result.recognizer;
              pushStream = result.pushStream;
              this.recognizers.set(callSid, recognizer);
              this.pushStreams.set(callSid, pushStream);
              console.log(`Azure recognizer ready for ${callSid}`);
            } catch (error) {
              console.error(`Failed to setup Azure recognizer: ${error.message}`);
            }
            break;

          case 'media':
            if (recognizer && pushStream && message.media.payload) {
              try {
                // Convert Twilio's base64 µ-law audio to PCM
                const mulawData = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
                const pcmData = this.convertMulawToPcm(mulawData);
                
                // Create proper WAV format for Azure
                const wavBuffer = this.createWavChunk(pcmData);
                
                // Push to Azure recognizer
                pushStream.write(wavBuffer);
                
                // Log every 10th chunk to avoid spam
                if (parseInt(message.media.chunk) % 10 === 0) {
                  console.log(`Chunk ${message.media.chunk}: ${mulawData.length} µ-law -> ${pcmData.length} PCM -> ${wavBuffer.length} WAV bytes`);
                }
              } catch (error) {
                console.error(`Error processing media chunk ${message.media.chunk}:`, error.message);
              }
            }
            break;

          case 'stop':
            console.log(`Call ${callSid} ended`);
            if (pushStream) {
              // Signal end of audio stream
              pushStream.close();
            }
            if (recognizer) {
              await this.cleanupRecognizer(callSid);
            }
            this.audioBuffers.delete(callSid);
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error.message);
      }
    });

    webSocket.addEventListener('close', () => {
      console.log(`Twilio WebSocket closed for ${callSid}`);
      this.sessions.delete(webSocket);
      if (callSid && this.recognizers.has(callSid)) {
        this.cleanupRecognizer(callSid).catch(err => console.error('Cleanup error:', err));
        this.audioBuffers.delete(callSid);
      }
    });
  }

  async setupAzureRecognizer(callSid) {
    try {
      console.log(`Setting up Azure recognizer for ${callSid}`);
      
      const speechConfig = speechSdk.SpeechConfig.fromSubscription(this.env.AZURE_SPEECH_KEY, this.env.AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';
      
      // Configure for streaming audio
      speechConfig.setProperty(speechSdk.PropertyId.SpeechServiceConnection_EnableAudioLogging, "true");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, "3000");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_InitialSilenceTimeoutMs, "3000");
      speechConfig.setProperty(speechSdk.PropertyId.Speech_EndSilenceTimeoutMs, "1000");

      // Create push stream with proper audio format
      const audioFormat = speechSdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
      const pushStream = speechSdk.AudioInputStream.createPushStream(audioFormat);
      const audioConfig = speechSdk.AudioConfig.fromStreamInput(pushStream);
      
      const recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);

      // Handle recognition results
      recognizer.recognizing = (s, e) => {
        if (e.result.reason === speechSdk.ResultReason.RecognizingSpeech && e.result.text) {
          console.log(`Recognizing: "${e.result.text}"`);
        }
      };

      recognizer.recognized = async (s, e) => {
        if (e.result.reason === speechSdk.ResultReason.RecognizedSpeech && e.result.text) {
          const transcript = e.result.text.trim();
          console.log(`RECOGNIZED: "${transcript}"`);
          
          await this.updateCallTranscript(callSid, transcript);
          this.broadcastTranscription(callSid, transcript, 'realtime');
        } else if (e.result.reason === speechSdk.ResultReason.NoMatch) {
          console.log(`No speech could be recognized: ${e.result.noMatchReason}`);
        }
      };

      recognizer.canceled = (s, e) => {
        console.error(`Recognition canceled: ${e.reason}, ${e.errorDetails}`);
        if (e.reason === speechSdk.CancellationReason.Error) {
          console.error(`Error details: ${e.errorDetails}`);
        }
      };

      recognizer.sessionStopped = () => {
        console.log(`Recognition session stopped for ${callSid}`);
      };

      // Start continuous recognition
      recognizer.startContinuousRecognitionAsync(
        () => {
          console.log(`Started continuous recognition for ${callSid}`);
        },
        (err) => {
          console.error(`Failed to start recognition: ${err}`);
        }
      );

      return { recognizer, pushStream };
    } catch (error) {
      console.error(`Error in setupAzureRecognizer:`, error);
      throw error;
    }
  }

  async cleanupRecognizer(callSid) {
    const recognizer = this.recognizers.get(callSid);
    const pushStream = this.pushStreams.get(callSid);

    if (recognizer) {
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            console.log(`Recognition stopped for ${callSid}`);
            recognizer.close();
          },
          (err) => {
            console.error(`Error stopping recognition: ${err}`);
            recognizer.close();
          }
        );
        this.recognizers.delete(callSid);
      } catch (error) {
        console.error(`Error cleaning up recognizer: ${error.message}`);
      }
    }

    if (pushStream) {
      try {
        pushStream.close();
        this.pushStreams.delete(callSid);
        console.log(`Push stream closed for ${callSid}`);
      } catch (error) {
        console.error(`Error closing push stream: ${error.message}`);
      }
    }
  }

  convertMulawToPcm(mulawData) {
    // µ-law to linear PCM conversion table (more accurate)
    const mulawToPcm = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      const mulaw = i;
      const sign = (mulaw & 0x80) ? -1 : 1;
      const exponent = (mulaw >> 4) & 0x07;
      const mantissa = mulaw & 0x0F;
      
      let sample = (mantissa << 3) + 33;
      sample = sample << exponent;
      sample = sample - 33;
      sample = sample * sign;
      
      // Clamp to 16-bit range
      sample = Math.max(-32768, Math.min(32767, sample));
      mulawToPcm[i] = sample;
    }

    const pcmData = new Int16Array(mulawData.length);
    for (let i = 0; i < mulawData.length; i++) {
      pcmData[i] = mulawToPcm[mulawData[i]];
    }

    return pcmData;
  }

  createWavChunk(pcmData) {
    // Convert Int16Array to Uint8Array (little-endian)
    const buffer = new ArrayBuffer(pcmData.length * 2);
    const view = new DataView(buffer);
    
    for (let i = 0; i < pcmData.length; i++) {
      view.setInt16(i * 2, pcmData[i], true); // true for little-endian
    }
    
    return new Uint8Array(buffer);
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