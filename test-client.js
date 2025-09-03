const WebSocket = require('ws');
const fetch = require('node-fetch');
const readline = require('readline');

/**
 * Test Client for AI Voice Call Router Test Harness
 * Provides an interactive interface for running tests
 */
class TestClient {
  constructor(harnessUrl = 'http://localhost:3001', wsUrl = 'ws://localhost:3002') {
    this.harnessUrl = harnessUrl;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.rl = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Connect to WebSocket
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.on('open', () => {
        console.log('✅ Connected to test harness');
        this.isConnected = true;
        this.showMenu();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      });

      this.ws.on('close', () => {
        console.log('❌ Disconnected from test harness');
        this.isConnected = false;
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });

      // Setup readline interface
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

    } catch (error) {
      console.error('Failed to connect:', error);
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case 'status':
        console.log('\n📊 Test Status:', message.data);
        break;
      case 'test_result':
        console.log('\n📋 Test Result:', message.data);
        break;
      case 'error':
        console.log('\n❌ Error:', message.data);
        break;
    }
  }

  showMenu() {
    console.log('\n🧪 AI Voice Call Router Test Client');
    console.log('=====================================');
    console.log('1. Run incoming call test');
    console.log('2. Run outgoing call test');
    console.log('3. Test audio processing');
    console.log('4. Test Asterisk integration');
    console.log('5. Test Azure Speech services');
    console.log('6. Run full integration test');
    console.log('7. View test results');
    console.log('8. Get system status');
    console.log('9. Exit');
    console.log('\nEnter your choice (1-9):');
    
    this.rl.question('', (answer) => {
      this.handleMenuChoice(answer.trim());
    });
  }

  async handleMenuChoice(choice) {
    switch (choice) {
      case '1':
        await this.runIncomingCallTest();
        break;
      case '2':
        await this.runOutgoingCallTest();
        break;
      case '3':
        await this.runAudioProcessingTest();
        break;
      case '4':
        await this.runAsteriskTest();
        break;
      case '5':
        await this.runAzureSpeechTest();
        break;
      case '6':
        await this.runFullIntegrationTest();
        break;
      case '7':
        await this.viewTestResults();
        break;
      case '8':
        await this.getSystemStatus();
        break;
      case '9':
        this.exit();
        break;
      default:
        console.log('Invalid choice. Please try again.');
        this.showMenu();
    }
  }

  async runIncomingCallTest() {
    console.log('\n📞 Running incoming call test...');
    
    const testConfig = {
      id: `incoming_${Date.now()}`,
      type: 'incoming_call',
      fromNumber: '+1234567890',
      toNumber: '+0987654321',
      duration: 5000,
      withAudio: true
    };

    await this.startTest(testConfig);
  }

  async runOutgoingCallTest() {
    console.log('\n📞 Running outgoing call test...');
    
    const testConfig = {
      id: `outgoing_${Date.now()}`,
      type: 'outgoing_call',
      fromNumber: '+0987654321',
      toNumber: '+1234567890'
    };

    await this.startTest(testConfig);
  }

  async runAudioProcessingTest() {
    console.log('\n🎵 Running audio processing test...');
    
    const testConfig = {
      id: `audio_${Date.now()}`,
      type: 'audio_processing',
      audioType: 'speech'
    };

    await this.startTest(testConfig);
  }

  async runAsteriskTest() {
    console.log('\n📡 Running Asterisk integration test...');
    
    const testConfig = {
      id: `asterisk_${Date.now()}`,
      type: 'asterisk_integration'
    };

    await this.startTest(testConfig);
  }

  async runAzureSpeechTest() {
    console.log('\n🗣️ Running Azure Speech test...');
    
    const testConfig = {
      id: `azure_${Date.now()}`,
      type: 'azure_speech'
    };

    await this.startTest(testConfig);
  }

  async runFullIntegrationTest() {
    console.log('\n🔄 Running full integration test...');
    
    const testConfig = {
      id: `integration_${Date.now()}`,
      type: 'full_integration'
    };

    await this.startTest(testConfig);
  }

  async startTest(testConfig) {
    try {
      const response = await fetch(`${this.harnessUrl}/test/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testConfig)
      });

      const result = await response.json();
      console.log(`✅ Test started: ${result.testId}`);
      
      // Wait a moment then show menu again
      setTimeout(() => {
        this.showMenu();
      }, 1000);

    } catch (error) {
      console.error('❌ Failed to start test:', error.message);
      this.showMenu();
    }
  }

  async viewTestResults() {
    try {
      const response = await fetch(`${this.harnessUrl}/test/results`);
      const data = await response.json();
      
      console.log('\n📋 Test Results:');
      console.log('================');
      
      if (data.results.length === 0) {
        console.log('No test results available.');
      } else {
        data.results.forEach((result, index) => {
          console.log(`\n${index + 1}. Test ID: ${result.id}`);
          console.log(`   Status: ${result.status}`);
          console.log(`   Duration: ${result.results?.duration || 'N/A'}ms`);
          console.log(`   Events: ${result.events?.length || 0}`);
          if (result.error) {
            console.log(`   Error: ${result.error}`);
          }
        });
      }
      
      this.showMenu();
    } catch (error) {
      console.error('❌ Failed to get test results:', error.message);
      this.showMenu();
    }
  }

  async getSystemStatus() {
    try {
      const response = await fetch(`${this.harnessUrl}/test/status`);
      const data = await response.json();
      
      console.log('\n📊 System Status:');
      console.log('=================');
      console.log(`Status: ${data.status}`);
      console.log(`Active Tests: ${data.activeTests}`);
      console.log(`Test Results: ${data.testResults}`);
      console.log(`Timestamp: ${data.timestamp}`);
      
      this.showMenu();
    } catch (error) {
      console.error('❌ Failed to get system status:', error.message);
      this.showMenu();
    }
  }

  exit() {
    console.log('\n👋 Goodbye!');
    if (this.ws) {
      this.ws.close();
    }
    if (this.rl) {
      this.rl.close();
    }
    process.exit(0);
  }
}

// CLI interface
if (require.main === module) {
  const client = new TestClient();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down test client...');
    client.exit();
  });
  
  client.connect();
}

module.exports = TestClient;
