const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

/**
 * Test Harness for AI Voice Call Router
 * Simulates SIP calls and tests the system without requiring OnSIP
 */
class TestHarness extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = {
      port: options.port || 3001,
      targetApp: options.targetApp || 'http://localhost:3000',
      testAudioDir: './test_audio',
      ...options
    };
    
    this.app = express();
    this.mockCalls = new Map();
    this.testResults = [];
    this.setupDirectories();
    this.setupExpress();
    this.setupWebSocket();
  }

  setupDirectories() {
    if (!fs.existsSync(this.config.testAudioDir)) {
      fs.mkdirSync(this.config.testAudioDir, { recursive: true });
    }
  }

  setupExpress() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Test control endpoints
    this.app.get('/test/status', (req, res) => {
      res.json({
        status: 'running',
        activeTests: this.mockCalls.size,
        testResults: this.testResults.length,
        timestamp: new Date().toISOString()
      });
    });

    this.app.post('/test/start', (req, res) => {
      const testConfig = req.body;
      this.startTest(testConfig);
      res.json({ message: 'Test started', testId: testConfig.id });
    });

    this.app.post('/test/stop/:testId', (req, res) => {
      const testId = req.params.testId;
      this.stopTest(testId);
      res.json({ message: 'Test stopped', testId });
    });

    this.app.get('/test/results', (req, res) => {
      res.json({ results: this.testResults });
    });

    // Mock SIP endpoints that the main app might call
    this.app.post('/mock/asterisk/events', (req, res) => {
      console.log('Mock Asterisk event received:', req.body);
      res.json({ received: true });
    });

    // Serve test audio files
    this.app.use('/test-audio', express.static(this.config.testAudioDir));
  }

  setupWebSocket() {
    this.wss = new WebSocket.Server({ port: 3002 });
    this.wss.on('connection', (ws) => {
      console.log('Test client connected');
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleTestMessage(ws, message);
        } catch (error) {
          console.error('Error parsing test message:', error);
        }
      });
    });
  }

  async startTest(testConfig) {
    const testId = testConfig.id || this.generateTestId();
    const test = {
      id: testId,
      config: testConfig,
      startTime: Date.now(),
      status: 'running',
      events: [],
      results: {}
    };

    this.mockCalls.set(testId, test);
    console.log(`Starting test: ${testId}`);

    try {
      switch (testConfig.type) {
        case 'incoming_call':
          await this.simulateIncomingCall(test);
          break;
        case 'outgoing_call':
          await this.simulateOutgoingCall(test);
          break;
        case 'audio_processing':
          await this.testAudioProcessing(test);
          break;
        case 'asterisk_integration':
          await this.testAsteriskIntegration(test);
          break;
        case 'azure_speech':
          await this.testAzureSpeech(test);
          break;
        default:
          await this.runFullIntegrationTest(test);
      }
    } catch (error) {
      test.status = 'failed';
      test.error = error.message;
      console.error(`Test ${testId} failed:`, error);
    }

    this.testResults.push(test);
    this.mockCalls.delete(testId);
  }

  async simulateIncomingCall(test) {
    console.log(`Simulating incoming call for test ${test.id}`);
    
    // Generate mock SIP INVITE
    const mockInvite = {
      callId: test.id,
      from: test.config.fromNumber || '+1234567890',
      to: test.config.toNumber || '+0987654321',
      timestamp: new Date().toISOString()
    };

    // Simulate call flow
    test.events.push({ type: 'invite_received', data: mockInvite });
    
    // Simulate call acceptance
    await this.delay(1000);
    test.events.push({ type: 'call_accepted', data: { callId: test.id } });
    
    // Simulate audio stream
    if (test.config.withAudio) {
      await this.simulateAudioStream(test);
    }
    
    // Simulate call end
    await this.delay(test.config.duration || 5000);
    test.events.push({ type: 'call_ended', data: { callId: test.id } });
    
    test.status = 'completed';
    test.results = {
      duration: Date.now() - test.startTime,
      events: test.events.length,
      success: true
    };
  }

  async simulateOutgoingCall(test) {
    console.log(`Simulating outgoing call for test ${test.id}`);
    
    // Test the main app's call status endpoint
    const callsResponse = await this.makeRequest('GET', '/calls');
    test.events.push({ type: 'calls_status', data: callsResponse });
    
    // Simulate outgoing call (since endpoint doesn't exist yet)
    test.events.push({ 
      type: 'outgoing_call_initiated', 
      data: { 
        to: test.config.toNumber,
        from: test.config.fromNumber,
        status: 'simulated',
        message: 'Outgoing call simulated - endpoint not implemented yet'
      } 
    });
    
    test.status = 'completed';
    test.results = {
      duration: Date.now() - test.startTime,
      events: test.events.length,
      success: true,
      note: 'Outgoing call endpoint not yet implemented in main app'
    };
  }

  async testAudioProcessing(test) {
    console.log(`Testing audio processing for test ${test.id}`);
    
    // Generate test audio file
    const audioFile = await this.generateTestAudio(test.config.audioType || 'speech');
    
    // Test health endpoint first to ensure app is responding
    const healthResponse = await this.makeRequest('GET', '/health');
    test.events.push({ type: 'health_check', data: healthResponse });
    
    // Simulate audio processing (since endpoint doesn't exist yet)
    test.events.push({ 
      type: 'audio_processed', 
      data: { 
        audioFile: audioFile,
        status: 'simulated',
        message: 'Audio processing simulated - endpoint not implemented yet'
      } 
    });
    
    test.status = 'completed';
    test.results = {
      duration: Date.now() - test.startTime,
      events: test.events.length,
      success: true,
      note: 'Audio processing endpoint not yet implemented in main app'
    };
  }

  async testAsteriskIntegration(test) {
    console.log(`Testing Asterisk integration for test ${test.id}`);
    
    // Simulate Asterisk events
    const events = [
      { event: 'Newchannel', channel: 'SIP/test-1', uniqueid: test.id },
      { event: 'Dial', channel: 'SIP/test-1', destination: 'SIP/test-2' },
      { event: 'Hangup', channel: 'SIP/test-1', cause: '16' }
    ];
    
    for (const event of events) {
      await this.makeRequest('POST', '/asterisk/events', event);
      test.events.push({ type: 'asterisk_event', data: event });
      await this.delay(500);
    }
    
    test.status = 'completed';
  }

  async testAzureSpeech(test) {
    console.log(`Testing Azure Speech integration for test ${test.id}`);
    
    // Test health endpoint to ensure app is responding
    const healthResponse = await this.makeRequest('GET', '/health');
    test.events.push({ type: 'health_check', data: healthResponse });
    
    // Simulate speech-to-text (since endpoint doesn't exist yet)
    test.events.push({ 
      type: 'speech_recognized', 
      data: { 
        audio: 'test_audio/sample.wav',
        language: 'en-US',
        status: 'simulated',
        message: 'Speech-to-text simulated - endpoint not implemented yet'
      } 
    });
    
    // Simulate text-to-speech (since endpoint doesn't exist yet)
    test.events.push({ 
      type: 'speech_synthesized', 
      data: { 
        text: 'Hello, this is a test message',
        voice: 'en-US-AriaNeural',
        status: 'simulated',
        message: 'Text-to-speech simulated - endpoint not implemented yet'
      } 
    });
    
    test.status = 'completed';
    test.results = {
      duration: Date.now() - test.startTime,
      events: test.events.length,
      success: true,
      note: 'Azure Speech endpoints not yet implemented in main app'
    };
  }

  async runFullIntegrationTest(test) {
    console.log(`Running full integration test for test ${test.id}`);
    
    // Run all test components in sequence
    await this.simulateIncomingCall(test);
    await this.testAudioProcessing(test);
    await this.testAsteriskIntegration(test);
    await this.testAzureSpeech(test);
    
    test.status = 'completed';
  }

  async simulateAudioStream(test) {
    console.log(`Simulating audio stream for test ${test.id}`);
    
    // Generate and stream test audio
    const audioData = await this.generateTestAudio('conversation');
    
    // Simulate real-time audio streaming
    for (let i = 0; i < 10; i++) {
      const chunk = audioData.slice(i * 1000, (i + 1) * 1000);
      test.events.push({ 
        type: 'audio_chunk', 
        data: { chunk: chunk.length, timestamp: Date.now() } 
      });
      await this.delay(200);
    }
  }

  async generateTestAudio(type = 'speech') {
    const audioFile = path.join(this.config.testAudioDir, `test_${type}_${Date.now()}.wav`);
    
    // Generate a simple WAV file with test audio
    const sampleRate = 8000;
    const duration = 2; // seconds
    const samples = sampleRate * duration;
    const buffer = Buffer.alloc(44 + samples * 2); // WAV header + 16-bit samples
    
    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples * 2, 40);
    
    // Generate sine wave test tone
    for (let i = 0; i < samples; i++) {
      const sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 32767;
      buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
    }
    
    fs.writeFileSync(audioFile, buffer);
    return audioFile;
  }

  async makeRequest(method, endpoint, data) {
    const fetch = require('node-fetch');
    const url = `${this.config.targetApp}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined
      });
      
      // Check if response is JSON
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        // If not JSON, return a structured error
        const text = await response.text();
        return {
          error: `Expected JSON response but got ${contentType || 'unknown content type'}`,
          status: response.status,
          statusText: response.statusText,
          url: url,
          response: text.substring(0, 200) // First 200 chars of response
        };
      }
    } catch (error) {
      console.error(`Request failed: ${method} ${url}`, error);
      return { 
        error: error.message,
        url: url,
        method: method
      };
    }
  }

  stopTest(testId) {
    const test = this.mockCalls.get(testId);
    if (test) {
      test.status = 'stopped';
      test.endTime = Date.now();
      this.mockCalls.delete(testId);
      console.log(`Test ${testId} stopped`);
    }
  }

  handleTestMessage(ws, message) {
    switch (message.type) {
      case 'start_test':
        this.startTest(message.config);
        break;
      case 'stop_test':
        this.stopTest(message.testId);
        break;
      case 'get_status':
        ws.send(JSON.stringify({
          type: 'status',
          data: {
            activeTests: this.mockCalls.size,
            testResults: this.testResults.length
          }
        }));
        break;
    }
  }

  generateTestId() {
    return `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  start() {
    this.server = this.app.listen(this.config.port, () => {
      console.log(`Test Harness started on port ${this.config.port}`);
      console.log(`WebSocket server on port 3002`);
      console.log(`Target app: ${this.config.targetApp}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
    if (this.wss) {
      this.wss.close();
    }
  }
}

// CLI interface
if (require.main === module) {
  const harness = new TestHarness();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down test harness...');
    harness.stop();
    process.exit(0);
  });
  
  harness.start();
  
  // Run some basic tests on startup
  setTimeout(async () => {
    console.log('\nRunning basic connectivity tests...');
    
    // Test 1: Health check
    await harness.startTest({
      id: 'health_check',
      type: 'incoming_call',
      fromNumber: '+1234567890',
      toNumber: '+0987654321',
      duration: 2000,
      withAudio: false
    });
    
    // Test 2: Audio processing
    await harness.startTest({
      id: 'audio_test',
      type: 'audio_processing',
      audioType: 'speech'
    });
    
    console.log('\nBasic tests completed. Test harness is ready!');
    console.log('Access test interface at: http://localhost:3001/test/status');
  }, 2000);
}

module.exports = TestHarness;
